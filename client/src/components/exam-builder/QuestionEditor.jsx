import { nanoid } from '@reduxjs/toolkit';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { metaFor, QUESTION_TYPE, DIFFICULTY_LEVELS, CODING_LANGUAGES, isAutoGrable } from '@/utils/questionTypes';

/**
 * Edits one question inside the builder's working draft.
 *
 * Fully **controlled**: it receives a `question` and emits the *next* question
 * via `onChange`, so the parent page owns the draft array and the eventual
 * `createExam`/`updateExam`/`addQuestions` calls. The server is the source of
 * truth for ordering, section assignment and recomputed totals — the editor only
 * shapes the single object the author is typing into.
 */
export function QuestionEditor({ question, index, onChange, onRemove, onMoveUp, onMoveDown }) {
  const meta = metaFor(question.type);
  const patch = (partial) => onChange({ ...question, ...partial });

  // ---- options handling (choice / true-false / matching / ordering) ----
  const options = question.options ?? [];
  const singleChoice = meta.singleChoice || question.type === QUESTION_TYPE.TRUE_FALSE;

  const setOptions = (next) => patch({ options: next });
  const addOption = () => setOptions([...options, { id: nanoid(6), text: '', correct: false }]);
  const updateOption = (position, field, value) =>
    setOptions(options.map((option, i) => (i === position ? { ...option, [field]: value } : option)));
  const removeOption = (position) => setOptions(options.filter((_, i) => i !== position));
  const markCorrect = (position, checked) =>
    setOptions(
      options.map((option, i) => {
        if (singleChoice) return { ...option, correct: i === position ? checked : false };
        return i === position ? { ...option, correct: checked } : option;
      }),
    );

  return (
    <div className="rounded-xl border bg-background p-4">
      <div className="mb-3 flex items-center gap-2">
        <GripVertical className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Question {index + 1}</span>
        <Badge variant="muted">{meta.label}</Badge>
        {isAutoGrable(question.type) ? <Badge variant="success">auto-graded</Badge> : <Badge variant="warning">manual grading</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={onMoveUp} aria-label="Move up">↑</Button>
          <Button size="icon" variant="ghost" onClick={onMoveDown} aria-label="Move down">↓</Button>
          {onRemove ? (
            <Button size="icon" variant="ghost" onClick={onRemove} aria-label="Delete question">
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Prompt</Label>
          <Textarea rows={2} value={question.prompt ?? ''} onChange={(event) => patch({ prompt: event.target.value })} placeholder="Enter the question text" />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Marks</Label>
            <Input type="number" min="0.5" step="0.5" value={question.marks ?? 1} onChange={(event) => patch({ marks: Number(event.target.value) })} />
          </div>
          <div className="space-y-1.5">
            <Label>Difficulty</Label>
            <Select value={question.difficulty ?? 'MEDIUM'} onValueChange={(value) => patch({ difficulty: value })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {DIFFICULTY_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>{level}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {question.type === QUESTION_TYPE.CODING ? (
            <div className="space-y-1.5">
              <Label>Language</Label>
              <Select value={question.language ?? 'javascript'} onValueChange={(value) => patch({ language: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CODING_LANGUAGES.map((lang) => (
                    <SelectItem key={lang.value} value={lang.value}>{lang.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        {meta.hasOptions && question.type !== QUESTION_TYPE.MATCHING && question.type !== QUESTION_TYPE.MATRIX ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Answer options</Label>
              <span className="text-xs text-muted-foreground">{singleChoice ? 'select one correct' : 'select all correct'}</span>
            </div>
            {options.map((option, position) => (
              <div key={option.id ?? position} className="flex items-center gap-2">
                <Checkbox
                  checked={Boolean(option.correct)}
                  onCheckedChange={(checked) => markCorrect(position, checked === true)}
                  aria-label="Mark correct"
                />
                <Input
                  value={option.text ?? ''}
                  onChange={(event) => updateOption(position, 'text', event.target.value)}
                  placeholder={`Option ${position + 1}`}
                />
                <Button size="icon" variant="ghost" onClick={() => removeOption(position)} aria-label="Remove option">
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={addOption} type="button">
              <Plus className="mr-1.5 h-4 w-4" /> Add option
            </Button>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label>Explanation (optional)</Label>
          <Textarea rows={2} value={question.explanation ?? ''} onChange={(event) => patch({ explanation: event.target.value })} placeholder="Shown to candidates in review" />
        </div>
      </div>
    </div>
  );
}

export default QuestionEditor;
