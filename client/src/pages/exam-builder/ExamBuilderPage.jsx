import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { nanoid } from '@reduxjs/toolkit';
import { Plus, Save, Send, Loader2, ArrowLeft } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import {
  fetchExam,
  selectCurrentExam,
  createExam,
  updateExam,
  publishExam,
} from '@/store/slices/examSlice';
import { selectIsAuthor } from '@/store/slices/authSlice';
import { toast } from '@/store/slices/uiSlice';
import { validate, examBasicsSchema, questionSchema } from '@/utils/validators';
import { DEFAULT_EXAM_SETTINGS, EXAM_TYPE_OPTIONS } from '@/utils/examConstants';
import { metaFor, QUESTION_TYPE } from '@/utils/questionTypes';
import { PageHeader } from '@/components/common/PageHeader';
import { QuestionEditor } from '@/components/exam-builder/QuestionEditor';
import { QuestionTypes } from '@/components/exam-builder/QuestionTypes';
import { SectionBuilder } from '@/components/exam-builder/SectionBuilder';
import { ExamSettings } from '@/components/exam-builder/ExamSettings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

function blankDraft() {
  return {
    id: null,
    title: '',
    description: '',
    instructions: '',
    type: 'TEST',
    category: '',
    language: 'en',
    status: 'DRAFT',
    settings: { ...DEFAULT_EXAM_SETTINGS },
    sections: [],
    questions: [],
  };
}

function newQuestion(type) {
  const meta = metaFor(type);
  const base = { tempId: nanoid(6), type, prompt: '', marks: 1, difficulty: 'MEDIUM', explanation: '' };
  if (meta.hasOptions || type === QUESTION_TYPE.TRUE_FALSE) {
    if (type === QUESTION_TYPE.TRUE_FALSE) {
      return { ...base, options: [{ id: 'true', text: 'True', correct: false }, { id: 'false', text: 'False', correct: false }] };
    }
    return { ...base, options: [{ id: nanoid(6), text: '', correct: false }, { id: nanoid(6), text: '', correct: false }] };
  }
  return base;
}

export default function ExamBuilderPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { examId } = useParams();
  const isAuthor = useAppSelector(selectIsAuthor);
  const loadedExam = useAppSelector(selectCurrentExam);

  const [draft, setDraft] = useState(blankDraft);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (examId) dispatch(fetchExam(examId));
  }, [dispatch, examId]);

  // Seed the local working draft once the server copy arrives (edit mode only).
  useEffect(() => {
    if (examId && loadedExam && loadedExam.id === examId) {
      setDraft({
        ...blankDraft(),
        ...loadedExam,
        settings: { ...DEFAULT_EXAM_SETTINGS, ...(loadedExam.settings ?? {}) },
        sections: loadedExam.sections ?? [],
        questions: loadedExam.questions ?? [],
      });
    }
  }, [examId, loadedExam]);

  const patchDraft = useCallback((partial) => setDraft((prev) => ({ ...prev, ...partial })), []);
  const patchSettings = useCallback((partial) => setDraft((prev) => ({ ...prev, settings: { ...prev.settings, ...partial } })), []);

  const setQuestion = (index, next) =>
    setDraft((prev) => ({ ...prev, questions: prev.questions.map((q, i) => (i === index ? next : q)) }));
  const removeQuestion = (index) => setDraft((prev) => ({ ...prev, questions: prev.questions.filter((_, i) => i !== index) }));
  const moveQuestion = (index, delta) =>
    setDraft((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.questions.length) return prev;
      const list = [...prev.questions];
      const [moved] = list.splice(index, 1);
      list.splice(to, 0, moved);
      return { ...prev, questions: list };
    });
  const addQuestion = (type) => {
    setDraft((prev) => ({ ...prev, questions: [...prev.questions, newQuestion(type)] }));
    setPickerOpen(false);
  };

  const totalMarks = useMemo(() => draft.questions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0), [draft.questions]);

  function buildPayload() {
    return {
      title: draft.title,
      description: draft.description,
      instructions: draft.instructions,
      type: draft.type,
      category: draft.category,
      language: draft.language,
      settings: draft.settings,
      sections: draft.sections.map(({ tempId, ...section }) => section),
      questions: draft.questions.map(({ tempId, ...question }, index) => ({ ...question, order: index })),
    };
  }

  async function handleSave(publish = false) {
    const basics = validate(examBasicsSchema, { title: draft.title, description: draft.description, type: draft.type, category: draft.category, language: draft.language });
    if (!basics.ok) {
      dispatch(toast({ title: 'Fix the basics', description: Object.values(basics.errors)[0], variant: 'error' }));
      return;
    }
    for (const question of draft.questions) {
      const check = validate(questionSchema, question);
      if (!check.ok) {
        dispatch(toast({ title: 'Question needs attention', description: Object.values(check.errors)[0], variant: 'error' }));
        return;
      }
    }

    setSaving(true);
    const payload = buildPayload();
    let examIdToUse = draft.id;
    let result;
    if (draft.id) {
      result = await dispatch(updateExam({ id: draft.id, patch: payload }));
    } else {
      result = await dispatch(createExam(payload));
      if (createExam.fulfilled.match(result)) {
        examIdToUse = result.payload.id;
        setDraft((prev) => ({ ...prev, id: result.payload.id }));
      }
    }
    setSaving(false);

    if (result.meta && result.meta.requestStatus !== 'fulfilled') {
      dispatch(toast({ title: 'Save failed', description: result.payload?.message ?? 'Try again', variant: 'error' }));
      return;
    }

    if (publish && examIdToUse) {
      await dispatch(publishExam({ id: examIdToUse }));
      dispatch(toast({ title: 'Exam published', description: 'Candidates can now see it.', variant: 'success' }));
      navigate(`/exams/${examIdToUse}`);
    } else {
      dispatch(toast({ title: 'Draft saved', description: 'Your changes are stored.', variant: 'success' }));
    }
  }

  if (!isAuthor) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        You don't have permission to build exams.
        <div><Button variant="link" onClick={() => navigate('/dashboard')}>Back to dashboard</Button></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={draft.id ? 'Edit exam' : 'Create exam'}
        description={`${draft.questions.length} questions · ${totalMarks} marks total`}
        breadcrumb={[{ label: 'Exams', to: '/exams' }, { label: draft.id ? 'Edit' : 'New' }]}
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate(-1)}><ArrowLeft className="mr-1.5 h-4 w-4" /> Back</Button>
            <Button variant="outline" onClick={() => handleSave(false)} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />} Save draft
            </Button>
            <Button onClick={() => handleSave(true)} disabled={saving}>
              <Send className="mr-1.5 h-4 w-4" /> Save &amp; publish
            </Button>
          </>
        }
      />

      <Tabs defaultValue="basics">
        <TabsList>
          <TabsTrigger value="basics">Basics</TabsTrigger>
          <TabsTrigger value="questions">Questions ({draft.questions.length})</TabsTrigger>
          <TabsTrigger value="sections">Sections</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="basics" className="mt-4">
          <div className="max-w-2xl space-y-4 rounded-xl border bg-background p-5">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={draft.title} onChange={(event) => patchDraft({ title: event.target.value })} placeholder="e.g. Midterm — Data Structures" />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea rows={3} value={draft.description} onChange={(event) => patchDraft({ description: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Instructions for candidates</Label>
              <Textarea rows={3} value={draft.instructions} onChange={(event) => patchDraft({ instructions: event.target.value })} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Exam type</Label>
                <Select value={draft.type} onValueChange={(value) => patchDraft({ type: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EXAM_TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Input value={draft.category} onChange={(event) => patchDraft({ category: event.target.value })} placeholder="e.g. Computer Science" />
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="questions" className="mt-4 space-y-4">
          {draft.questions.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No questions yet.</div>
          ) : (
            draft.questions.map((question, index) => (
              <QuestionEditor
                key={question.tempId ?? question.id ?? index}
                question={question}
                index={index}
                onChange={(next) => setQuestion(index, next)}
                onRemove={() => removeQuestion(index)}
                onMoveUp={() => moveQuestion(index, -1)}
                onMoveDown={() => moveQuestion(index, 1)}
              />
            ))
          )}
          <Button variant="outline" onClick={() => setPickerOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Add question
          </Button>
        </TabsContent>

        <TabsContent value="sections" className="mt-4">
          <SectionBuilder sections={draft.sections} onChange={(sections) => patchDraft({ sections })} />
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <ExamSettings settings={draft.settings} onChange={patchSettings} />
        </TabsContent>
      </Tabs>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>Choose a question type</DialogTitle></DialogHeader>
          <QuestionTypes onSelect={addQuestion} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
