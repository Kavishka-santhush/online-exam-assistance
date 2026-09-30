import { lazy, Suspense, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { QUESTION_TYPE } from '@/utils/questionTypes';
import { resolveUploadUrl } from '@/utils/download';

/**
 * Renders the answer control for a single question, driven entirely by its
 * `type` (from `utils/questionTypes`). It is a **controlled, presentational**
 * component: the candidate answer arrives via `value` and every edit is pushed
 * up through `onChange`, so the parent (`ExamInterface`) owns persistence
 * (optimistic local write + `saveAnswer` thunk) and this file never touches the
 * store or network.
 *
 * `review` mode (used by the result/review screen) renders the same layout but
 * read-only and, when the server included answer keys, highlights correct
 * options and marks the candidate's selection.
 *
 * Answer payload shapes are the contract shared with the server's auto-grader:
 *   choice→optionId · multi→optionId[] · boolean→true/false · text→string ·
 *   numeric→number · date→ISO string · rating→number · matching/dropdown/
 *   matrix→object map · ordering→ordered id[] · hotspot→point[] · coding→
 *   { language, code } · file→{ name, url }.
 */

function optionId(option, index) {
  return option.id ?? option.value ?? String(index);
}

function OptionMedia({ option }) {
  const src = resolveUploadUrl(option.imageUrl ?? option.image);
  if (!src) return null;
  return <img src={src} alt="" className="mt-2 max-h-40 rounded-md border object-contain" />;
}

export function QuestionRenderer({ question, value, onChange, disabled = false, review = false }) {
  const type = question.type;
  const options = question.options ?? [];

  // `answer` carries the grading keys; the runtime normally strips it, but the
  // review screen re-sends it so we can highlight correctness.
  const answerKey = useMemo(() => question.answer ?? question.correctAnswer ?? null, [question]);

  const readOnly = disabled || review;
  const set = (next) => !readOnly && onChange?.(next);

  switch (type) {
    case QUESTION_TYPE.MULTIPLE_CHOICE:
      return (
        <RadioGroup
          className="space-y-2.5"
          value={value ?? ''}
          onValueChange={(next) => set(next)}
          disabled={readOnly}
        >
          {options.map((option, index) => {
            const id = optionId(option, index);
            const correct = option.correct || answerKey === id;
            const chosen = value === id;
            return (
              <Label
                key={id}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-sm font-normal transition-colors',
                  !readOnly && 'cursor-pointer hover:bg-muted',
                  review && correct && 'border-emerald-500 bg-emerald-500/10',
                  review && chosen && !correct && 'border-destructive bg-destructive/10',
                )}
              >
                <RadioGroupItem value={id} className="mt-0.5" />
                <span className="flex-1">
                  {option.text}
                  <OptionMedia option={option} />
                </span>
                {review && correct ? <span className="text-xs font-semibold text-emerald-600">✓ correct</span> : null}
              </Label>
            );
          })}
        </RadioGroup>
      );

    case QUESTION_TYPE.MULTIPLE_ANSWER: {
      const selected = Array.isArray(value) ? value : [];
      const toggle = (id, checked) => {
        const next = checked ? [...selected, id] : selected.filter((entry) => entry !== id);
        set(next);
      };
      return (
        <div className="space-y-2.5">
          {options.map((option, index) => {
            const id = optionId(option, index);
            const correct = option.correct || (Array.isArray(answerKey) && answerKey.includes(id));
            const chosen = selected.includes(id);
            return (
              <Label
                key={id}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-sm font-normal',
                  !readOnly && 'cursor-pointer hover:bg-muted',
                  review && correct && 'border-emerald-500 bg-emerald-500/10',
                  review && chosen && !correct && 'border-destructive bg-destructive/10',
                )}
              >
                <Checkbox checked={chosen} onCheckedChange={(checked) => toggle(id, checked === true)} disabled={readOnly} className="mt-0.5" />
                <span className="flex-1">
                  {option.text}
                  <OptionMedia option={option} />
                </span>
                {review && correct ? <span className="text-xs font-semibold text-emerald-600">✓</span> : null}
              </Label>
            );
          })}
        </div>
      );
    }

    case QUESTION_TYPE.TRUE_FALSE: {
      const truthValue = value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : '';
      const correctTruth = answerKey === true || answerKey === 'true' ? 'true' : answerKey === false || answerKey === 'false' ? 'false' : null;
      return (
        <RadioGroup className="gap-2.5 sm:flex-row" value={truthValue} onValueChange={(next) => set(next === 'true')} disabled={readOnly}>
          {['true', 'false'].map((choice) => (
            <Label
              key={choice}
              className={cn(
                'flex flex-1 items-center gap-2 rounded-lg border p-3 text-sm font-normal capitalize',
                !readOnly && 'cursor-pointer hover:bg-muted',
                review && correctTruth === choice && 'border-emerald-500 bg-emerald-500/10',
              )}
            >
              <RadioGroupItem value={choice} /> {choice}
            </Label>
          ))}
        </RadioGroup>
      );
    }

    case QUESTION_TYPE.SHORT_ANSWER:
    case QUESTION_TYPE.FILL_BLANK:
      return (
        <Input
          value={value ?? ''}
          disabled={readOnly}
          placeholder="Type your answer"
          onChange={(event) => set(event.target.value)}
        />
      );

    case QUESTION_TYPE.LONG_ANSWER:
      return (
        <Textarea
          value={value ?? ''}
          disabled={readOnly}
          rows={8}
          placeholder="Write your full answer…"
          onChange={(event) => set(event.target.value)}
        />
      );

    case QUESTION_TYPE.NUMERIC:
      return (
        <Input
          type="number"
          value={value ?? ''}
          disabled={readOnly}
          onChange={(event) => set(event.target.value === '' ? '' : Number(event.target.value))}
          className="max-w-xs"
        />
      );

    case QUESTION_TYPE.DATE:
      return (
        <Input
          type="date"
          value={value ?? ''}
          disabled={readOnly}
          onChange={(event) => set(event.target.value)}
          className="max-w-xs"
        />
      );

    case QUESTION_TYPE.RATING: {
      const max = question.max ?? 5;
      const current = Number(value ?? 0);
      return (
        <div className="flex gap-1.5">
          {Array.from({ length: max }).map((_, index) => {
            const star = index + 1;
            return (
              <button
                key={star}
                type="button"
                disabled={readOnly}
                onClick={() => set(star === current ? 0 : star)}
                className={cn(
                  'grid size-10 place-items-center rounded-md border text-sm font-semibold transition-colors',
                  star <= current ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {star}
              </button>
            );
          })}
        </div>
      );
    }

    case QUESTION_TYPE.DROPDOWN: {
      const choices = question.dropdownChoices ?? options.map((option, index) => ({ id: optionId(option, index), text: option.text }));
      const current = value && typeof value === 'object' ? value[question.id] ?? '' : value ?? '';
      return (
        <Select value={String(current)} onValueChange={(next) => set(next)} disabled={readOnly}>
          <SelectTrigger className="max-w-xs">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={optionId(choice, 0)} value={String(optionId(choice, 0))}>
                {choice.text}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    case QUESTION_TYPE.MATCHING: {
      const pairs = question.pairs ?? options;
      const targets = question.targets ?? pairs.map((pair) => ({ id: pair.matchId ?? pair.id, text: pair.matchText ?? pair.right ?? pair.text }));
      const map = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return (
        <div className="space-y-2.5">
          {pairs.map((pair, index) => {
            const leftId = optionId(pair, index);
            const correct = answerKey ? answerKey[leftId] : pair.matchId;
            return (
              <div key={leftId} className="grid grid-cols-2 items-center gap-3">
                <span className="text-sm">{pair.text ?? pair.left}</span>
                <Select
                  value={map[leftId] ?? ''}
                  disabled={readOnly}
                  onValueChange={(next) => set({ ...map, [leftId]: next })}
                >
                  <SelectTrigger className={cn(review && correct && map[leftId] === correct && 'border-emerald-500')}>
                    <SelectValue placeholder="Match…" />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((target) => (
                      <SelectItem key={target.id} value={String(target.id)}>
                        {target.text}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      );
    }

    case QUESTION_TYPE.ORDERING: {
      const orderedIds = Array.isArray(value) ? value : [];
      const pool = options.map((option, index) => ({ id: optionId(option, index), text: option.text }));
      const items = orderedIds.length ? orderedIds.map((id) => pool.find((item) => item.id === id) ?? { id, text: id }) : pool;
      const move = (from, to) => {
        if (to < 0 || to >= items.length) return;
        const next = [...items];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        set(next.map((item) => item.id));
      };
      return (
        <ol className="space-y-2">
          {items.map((item, index) => (
            <li key={item.id} className="flex items-center gap-3 rounded-lg border p-2.5 text-sm">
              <span className="grid size-6 shrink-0 place-items-center rounded bg-muted text-xs font-semibold">{index + 1}</span>
              <span className="flex-1">{item.text}</span>
              {!readOnly ? (
                <span className="flex gap-1">
                  <button type="button" className="rounded border px-2 py-1 text-xs disabled:opacity-40" onClick={() => move(index, index - 1)} disabled={index === 0}>↑</button>
                  <button type="button" className="rounded border px-2 py-1 text-xs disabled:opacity-40" onClick={() => move(index, index + 1)} disabled={index === items.length - 1}>↓</button>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      );
    }

    case QUESTION_TYPE.MATRIX: {
      const rows = question.rows ?? options.map((option, index) => ({ id: optionId(option, index), text: option.text }));
      const cols = question.columns ?? question.scale ?? [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }];
      const map = value && typeof value === 'object' ? value : {};
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="p-2 text-left font-medium" />
                {cols.map((col) => (
                  <th key={col.id} className="p-2 text-center font-medium">{col.text}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="p-2">{row.text}</td>
                  {cols.map((col) => (
                    <td key={col.id} className="p-2 text-center">
                      <RadioGroup className="justify-center" value={map[row.id] ?? ''} disabled={readOnly} onValueChange={() => set({ ...map, [row.id]: col.id })}>
                        <RadioGroupItem value={col.id} />
                      </RadioGroup>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case QUESTION_TYPE.HOTSPOT: {
      const points = Array.isArray(value) ? value : [];
      const src = resolveUploadUrl(question.imageUrl ?? question.image);
      const handleClick = (event) => {
        if (readOnly || !event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        set([...points, { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) }]);
      };
      return (
        <div className="space-y-2">
          {src ? (
            <div className="relative inline-block">
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
              <img src={src} alt="" onClick={handleClick} className={cn('max-h-[420px] rounded-md border', !readOnly && 'cursor-crosshair')} />
              {points.map((point, index) => (
                <span key={index} className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-background" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No image supplied for this hotspot question.</p>
          )}
          {!readOnly && points.length ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => set([])}>
              Clear marks
            </Button>
          ) : null}
        </div>
      );
    }

    case QUESTION_TYPE.FILE_UPLOAD: {
      const file = value && typeof value === 'object' ? value : null;
      return (
        <div className="space-y-2">
          <Input
            type="file"
            disabled={readOnly}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) set({ name: selected.name, size: selected.size, type: selected.type });
            }}
          />
          {file?.name ? <p className="text-sm text-muted-foreground">Selected: {file.name}</p> : null}
        </div>
      );
    }

    case QUESTION_TYPE.CODING:
      return <CodingEditor question={question} value={value} onChange={onChange} disabled={readOnly} />;

    default:
      return (
        <Textarea
          value={typeof value === 'string' ? value : JSON.stringify(value ?? '')}
          disabled={readOnly}
          onChange={(event) => set(event.target.value)}
          rows={4}
        />
      );
  }
}

/** Lightweight import so Monaco only loads for coding questions. */
const MonacoEditor = lazy(() => import('@monaco-editor/react'));

function CodingEditor({ question, value, onChange, disabled }) {
  const language = value?.language ?? question.language ?? 'javascript';
  const code = value?.code ?? '';
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 text-xs">
        <span>Language</span>
        <Select value={language} disabled={disabled} onValueChange={(next) => onChange?.({ ...value, language: next, code })}>
          <SelectTrigger className="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[{ value: 'javascript', label: 'JavaScript' }, { value: 'python', label: 'Python' }, { value: 'java', label: 'Java' }, { value: 'cpp', label: 'C++' }, { value: 'typescript', label: 'TypeScript' }, { value: 'sql', label: 'SQL' }].map((lang) => (
              <SelectItem key={lang.value} value={lang.value}>{lang.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Suspense fallback={<div className="grid h-72 place-items-center text-sm text-muted-foreground">Loading editor…</div>}>
        <MonacoEditor
          height="288px"
          language={language}
          theme="vs-light"
          value={code}
          onChange={(next) => onChange?.({ language, code: next ?? '' })}
          options={{ readOnly: disabled, minimap: { enabled: false }, fontSize: 14, scrollBeyondLastLine: false, automaticLayout: true }}
        />
      </Suspense>
    </div>
  );
}

export default QuestionRenderer;
