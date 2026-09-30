import { nanoid } from '@reduxjs/toolkit';
import { Plus, Trash2, Layers } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/common/EmptyState';

/**
 * Section editor for the exam draft.
 *
 * Sections are an optional grouping layer (a "Section A – MCQ", a time-boxed
 * part, etc.). The server owns final ordering and pool draws, so like the
 * question editor this is controlled: it emits the next `sections` array via
 * `onChange` and the page persists it on save. When a draft has no sections the
 * builder shows a single flat question list instead.
 */
export function SectionBuilder({ sections = [], onChange }) {
  const patch = (id, partial) => onChange(sections.map((section) => (section.tempId === id || section.id === id ? { ...section, ...partial } : section)));
  const remove = (id) => onChange(sections.filter((section) => (section.tempId ?? section.id) !== id));
  const add = () =>
    onChange([
      ...sections,
      { tempId: nanoid(6), title: `Section ${sections.length + 1}`, description: '', order: sections.length, timeLimitSec: null, shuffle: false, questions: [] },
    ]);

  if (sections.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          compact
          icon={<Layers className="h-5 w-5" />}
          title="No sections"
          description="Sections are optional — questions can live in one flat list. Add a section to group or time-box parts of the exam."
          action={
            <Button type="button" onClick={add}>
              <Plus className="mr-1.5 h-4 w-4" /> Add section
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sections.map((section, index) => {
        const key = section.tempId ?? section.id;
        return (
          <div key={key} className="rounded-xl border bg-background p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-md bg-muted text-xs font-semibold">{index + 1}</span>
              <Input
                className="h-8 flex-1 border-0 bg-transparent px-0 font-semibold focus-visible:ring-0"
                value={section.title ?? ''}
                onChange={(event) => patch(key, { title: event.target.value })}
              />
              <Button size="icon" variant="ghost" onClick={() => remove(key)} aria-label="Remove section">
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Time limit (seconds, optional)</Label>
                <Input
                  type="number"
                  value={section.timeLimitSec ?? ''}
                  onChange={(event) => patch(key, { timeLimitSec: event.target.value === '' ? null : Number(event.target.value) })}
                />
              </div>
              <div className="flex items-end gap-2 pb-2">
                <Switch checked={Boolean(section.shuffle)} onCheckedChange={(checked) => patch(key, { shuffle: checked })} id={`shuffle-${key}`} />
                <Label htmlFor={`shuffle-${key}`}>Shuffle questions in section</Label>
              </div>
            </div>
            <Textarea
              className="mt-2"
              rows={2}
              placeholder="Section instructions (optional)"
              value={section.description ?? ''}
              onChange={(event) => patch(key, { description: event.target.value })}
            />
          </div>
        );
      })}
      <Button type="button" variant="outline" onClick={add}>
        <Plus className="mr-1.5 h-4 w-4" /> Add section
      </Button>
    </div>
  );
}

export default SectionBuilder;
