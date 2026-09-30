import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Layers, Plus, Search, Trash2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectIsAuthor } from '@/store/slices/authSlice';
import { toast } from '@/store/slices/uiSlice';
import { request, endpoints } from '@/lib/apiClient';
import { useDebouncedValue } from '@/hooks/useDebounce';
import { metaFor, questionTypeOptions, QUESTION_TYPE } from '@/utils/questionTypes';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QuestionEditor } from '@/components/exam-builder/QuestionEditor';
import { QuestionRenderer } from '@/components/exam-taking/QuestionRenderer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Question-bank detail (`/question-banks/:bankId`).
 *
 * The bank's questions are a filtered view of the global `/questions` resource
 * (`?bankId=`), not a nested sub-route — so we page them independently of the
 * bank header. Adding/editing reuses the same controlled `QuestionEditor` the
 * exam builder uses, then POSTs/PATCHes a single question; crucially the
 * answer options live under `content` (the server's storage contract), so we
 * fold the editor's top-level `options` into `content` on the way out and the
 * bank's `questionCount` is bumped server-side, never here.
 */
export default function QuestionBankDetailPage() {
  const dispatch = useAppDispatch();
  const { bankId } = useParams();
  const isAuthor = useAppSelector(selectIsAuthor);

  const [bank, setBank] = useState(null);
  const [questions, setQuestions] = useState(null);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 250);
  const [typeFilter, setTypeFilter] = useState('ALL');

  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);

  const typeOptions = useMemo(() => questionTypeOptions(), []);

  const loadQuestions = useCallback(() => {
    request
      .paged(endpoints.questions.list, { params: { bankId, limit: 100 } })
      .then(({ data }) => setQuestions(data))
      .catch((err) => dispatch(toast({ title: 'Could not load questions', description: err.message, variant: 'error' })));
  }, [bankId, dispatch]);

  useEffect(() => {
    let alive = true;
    request.get(endpoints.questionBanks.byId(bankId)).then((data) => alive && setBank(data)).catch(() => {});
    loadQuestions();
    return () => { alive = false; };
  }, [bankId, loadQuestions]);

  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    return (questions ?? []).filter((question) => {
      if (typeFilter !== 'ALL' && question.type !== typeFilter) return false;
      if (q && !String(question.prompt).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [questions, debounced, typeFilter]);

  function openNew(type = QUESTION_TYPE.MULTIPLE_CHOICE) {
    setEditingExisting(false);
    setDraft(seedQuestion(type));
    setEditorOpen(true);
  }

  async function openEdit(question) {
    try {
      const full = await request.get(endpoints.questions.byId(question.id));
      setEditingExisting(true);
      setDraft({ ...full, options: full.content?.options ?? full.options ?? [] });
      setEditorOpen(true);
    } catch (err) {
      dispatch(toast({ title: 'Could not open question', description: err.message, variant: 'error' }));
    }
  }

  async function saveQuestion() {
    if (!draft?.prompt?.trim()) { dispatch(toast({ title: 'Prompt required', variant: 'error' })); return; }
    setSaving(true);
    const { options, answer, ...rest } = draft;
    const body = { ...rest, bankId, content: { ...(draft.content ?? {}), options, answer } };
    try {
      if (editingExisting) {
        const updated = await request.patch(endpoints.questions.byId(draft.id), body);
        setQuestions((prev) => prev.map((q) => (q.id === draft.id ? { ...q, ...updated } : q)));
      } else {
        const created = await request.post(endpoints.questions.root, body);
        setQuestions((prev) => [created, ...prev]);
        setBank((prev) => (prev ? { ...prev, questionCount: (prev.questionCount ?? 0) + 1 } : prev));
      }
      setEditorOpen(false);
      dispatch(toast({ title: editingExisting ? 'Question updated' : 'Question added', variant: 'success' }));
    } catch (err) {
      dispatch(toast({ title: 'Save failed', description: err.details?.message ?? err.message, variant: 'error' }));
    } finally {
      setSaving(false);
    }
  }

  async function removeQuestion(id) {
    try {
      await request.delete(endpoints.questions.byId(id));
      setQuestions((prev) => prev.filter((q) => q.id !== id));
      setBank((prev) => (prev ? { ...prev, questionCount: Math.max(0, (prev.questionCount ?? 1) - 1) } : prev));
      dispatch(toast({ title: 'Question deleted', variant: 'success' }));
    } catch (err) {
      dispatch(toast({ title: 'Delete failed', description: err.message, variant: 'error' }));
    }
  }

  async function showPreview(id) {
    try {
      const full = await request.get(endpoints.questions.byId(id));
      setPreview(full);
    } catch {
      dispatch(toast({ title: 'Could not load preview', variant: 'error' }));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={bank?.name ?? 'Question bank'}
        description={bank?.description}
        breadcrumb={[{ label: 'Question banks', to: '/question-banks' }, { label: bank?.name ?? 'Bank' }]}
        actions={isAuthor ? <Button onClick={() => openNew()}><Plus className="mr-1.5 h-4 w-4" /> Add question</Button> : null}
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search questions…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All types</SelectItem>
            {typeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Badge variant="muted" className="gap-1"><Layers className="h-3 w-3" /> {bank?.questionCount ?? questions?.length ?? 0}</Badge>
      </div>

      {questions === null ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-6 w-6" />}
          title="No questions here"
          description={isAuthor ? 'Add your first question to this bank.' : 'This bank has no matching questions.'}
          action={isAuthor ? <Button onClick={() => openNew()}><Plus className="mr-1.5 h-4 w-4" /> Add question</Button> : null}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((question, index) => (
            <Card key={question.id}>
              <CardContent className="flex items-center gap-3 p-3">
                <span className="w-6 shrink-0 text-center text-sm text-muted-foreground">{index + 1}</span>
                <button type="button" onClick={() => showPreview(question.id)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium">{question.prompt}</p>
                  <p className="text-xs text-muted-foreground">{metaFor(question.type).label} · {question.marks ?? 1} mark(s) · {question.difficulty ?? 'MEDIUM'}</p>
                </button>
                {isAuthor ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(question)}>Edit</Button>
                    <Button size="icon" variant="ghost" onClick={() => removeQuestion(question.id)} aria-label="Delete">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* add / edit */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{editingExisting ? 'Edit question' : 'New question'}</DialogTitle></DialogHeader>
          {draft ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                {typeOptions.slice(0, 6).map((option) => (
                  <Button key={option.value} size="sm" variant={draft.type === option.value ? 'default' : 'outline'} onClick={() => setDraft(seedQuestion(option.value))}>
                    {option.label}
                  </Button>
                ))}
              </div>
              <div className="max-h-[50vh] overflow-y-auto pr-1">
                <QuestionEditor question={draft} index={0} onChange={setDraft} />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
                <Button onClick={saveQuestion} disabled={saving}>{saving ? 'Saving…' : 'Save question'}</Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* read-only preview */}
      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{metaFor(preview?.type).label}</DialogTitle></DialogHeader>
          {preview ? (
            <div className="space-y-3">
              <p className="font-medium">{preview.prompt}</p>
              <QuestionRenderer question={{ ...preview, options: preview.content?.options ?? preview.options ?? [] }} value={undefined} review disabled />
              {preview.explanation ? <p className="rounded-lg bg-muted/50 p-3 text-sm">{preview.explanation}</p> : null}
              <div className="flex justify-end"><Button variant="outline" onClick={() => setPreview(null)}>Close</Button></div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {!isAuthor ? <p className="text-xs text-muted-foreground"><Link to="/question-banks" className="underline">← All banks</Link></p> : null}
    </div>
  );
}

// Seed a fresh question of `type`. Choice/true-false get starter options so
// the editor's "mark correct" UI is usable immediately.
function seedQuestion(type) {
  const base = { type, prompt: '', marks: 1, difficulty: 'MEDIUM', explanation: '', options: [] };
  if (type === QUESTION_TYPE.TRUE_FALSE) return { ...base, options: [{ id: 'true', text: 'True', correct: true }, { id: 'false', text: 'False', correct: false }] };
  if ([QUESTION_TYPE.MULTIPLE_CHOICE, QUESTION_TYPE.MULTIPLE_ANSWER].includes(type)) {
    return { ...base, options: [{ id: 'opt-1', text: '', correct: true }, { id: 'opt-2', text: '', correct: false }] };
  }
  return base;
}
