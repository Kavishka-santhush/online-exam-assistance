import { ListChecks, Type, MousePointerClick, Code2, Star } from 'lucide-react';
import { QUESTION_GROUPS, QUESTION_TYPE_META, questionTypeOptions } from '@/utils/questionTypes';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const GROUP_ICON = {
  Choice: ListChecks,
  Text: Type,
  Interactive: MousePointerClick,
  Code: Code2,
  Survey: Star,
};

/**
 * Question-type palette shown when the author clicks "Add question".
 *
 * It is the visual counterpart of `utils/questionTypes`: instead of scattering a
 * hard-coded list of type names across the builder, we derive the grouped grid
 * straight from the same metadata the renderer and grader use, so adding a new
 * question type only ever touches the utils file.
 */
export function QuestionTypes({ onSelect, className }) {
  const options = questionTypeOptions();
  return (
    <div className={cn('space-y-5', className)}>
      {QUESTION_GROUPS.map((group) => {
        const items = options.filter((option) => option.group === group);
        if (items.length === 0) return null;
        const Icon = GROUP_ICON[group] ?? ListChecks;
        return (
          <div key={group}>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Icon className="h-4 w-4" /> {group}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((item) => {
                const meta = QUESTION_TYPE_META[item.value];
                return (
                  <button key={item.value} type="button" onClick={() => onSelect(item.value)} className="text-left">
                    <Card className="h-full transition-colors hover:border-primary hover:bg-primary/[0.03]">
                      <CardContent className="p-3">
                        <p className="text-sm font-medium">{item.label}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{meta.description}</p>
                      </CardContent>
                    </Card>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default QuestionTypes;
