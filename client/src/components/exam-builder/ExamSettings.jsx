import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RESULT_VISIBILITY_OPTIONS, EXAM_ACCESS_OPTIONS, DEFAULT_EXAM_SETTINGS } from '@/utils/examConstants';

/**
 * The "Settings" tab of the exam builder.
 *
 * Binds to the exam `settings` JSON blob, pre-merged by the caller with
 * `DEFAULT_EXAM_SETTINGS` so every field has a defined value (the server keeps
 * the identical defaults). `onChange` receives a *shallow patch* of the settings
 * object; nested blocks (`negativeMarking`, `proctoring`) are patched by
 * spreading their current value so we never clobber sibling keys.
 */
export function ExamSettings({ settings, onChange }) {
  const s = { ...DEFAULT_EXAM_SETTINGS, ...settings };
  const patch = (partial) => onChange?.(partial);
  const patchProctoring = (partial) => patch({ proctoring: { ...s.proctoring, ...partial } });

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Scoring &amp; timing</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Time limit (seconds)</Label>
              <Input
                type="number"
                value={s.timeLimitSec ?? ''}
                placeholder="e.g. 3600"
                onChange={(event) => patch({ timeLimitSec: event.target.value === '' ? null : Number(event.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Passing score (%)</Label>
              <Input type="number" min="0" max="100" value={s.passingScorePercent} onChange={(event) => patch({ passingScorePercent: Number(event.target.value) })} />
            </div>
            <div className="space-y-1.5">
              <Label>Max attempts</Label>
              <Input type="number" min="1" value={s.attemptLimit} onChange={(event) => patch({ attemptLimit: Number(event.target.value) })} />
            </div>
            <div className="space-y-1.5">
              <Label>Per-question time (s)</Label>
              <Input type="number" value={s.perQuestionTimeSec ?? ''} onChange={(event) => patch({ perQuestionTimeSec: event.target.value === '' ? null : Number(event.target.value) })} />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Label>Negative marking</Label>
            <Switch checked={s.negativeMarking?.enabled} onCheckedChange={(checked) => patch({ negativeMarking: { ...s.negativeMarking, enabled: checked } })} />
          </div>
          {s.negativeMarking?.enabled ? (
            <div className="space-y-1.5">
              <Label>Penalty (%)</Label>
              <Input type="number" min="0" max="100" value={s.negativeMarking.percent} onChange={(event) => patch({ negativeMarking: { ...s.negativeMarking, percent: Number(event.target.value) } })} />
            </div>
          ) : null}
          <Separator />
          <div className="flex items-center justify-between">
            <Label>Shuffle questions</Label>
            <Switch checked={s.shuffleQuestions} onCheckedChange={(checked) => patch({ shuffleQuestions: checked })} />
          </div>
          <div className="flex items-center justify-between">
            <Label>Shuffle options</Label>
            <Switch checked={s.shuffleOptions} onCheckedChange={(checked) => patch({ shuffleOptions: checked })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Access &amp; results</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Who can take this exam</Label>
            <Select value={s.access} onValueChange={(value) => patch({ access: value })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXAM_ACCESS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>When candidates see results</Label>
            <Select value={s.resultVisibility} onValueChange={(value) => patch({ resultVisibility: value })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RESULT_VISIBILITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <Label>Show correct answers in review</Label>
            <Switch checked={s.showCorrectAnswers} onCheckedChange={(checked) => patch({ showCorrectAnswers: checked })} />
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Proctoring</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">Proctored exam</Label>
              <p className="text-sm text-muted-foreground">Enable camera, lockdown and live monitoring.</p>
            </div>
            <Switch checked={s.isProctored} onCheckedChange={(checked) => patch({ isProctored: checked })} />
          </div>
          {s.isProctored ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-center justify-between">
                <Label>Require camera</Label>
                <Switch checked={s.proctoring?.requireCamera} onCheckedChange={(checked) => patchProctoring({ requireCamera: checked })} />
              </div>
              <div className="flex items-center justify-between">
                <Label>Require microphone</Label>
                <Switch checked={s.proctoring?.requireMicrophone} onCheckedChange={(checked) => patchProctoring({ requireMicrophone: checked })} />
              </div>
              <div className="flex items-center justify-between">
                <Label>Require screen share</Label>
                <Switch checked={s.proctoring?.requireScreenShare} onCheckedChange={(checked) => patchProctoring({ requireScreenShare: checked })} />
              </div>
              <div className="flex items-center justify-between">
                <Label>Browser lockdown</Label>
                <Switch checked={s.proctoring?.browserLockdown} onCheckedChange={(checked) => patchProctoring({ browserLockdown: checked })} />
              </div>
              <div className="flex items-center justify-between">
                <Label>Force fullscreen</Label>
                <Switch checked={s.proctoring?.fullscreenRequired} onCheckedChange={(checked) => patchProctoring({ fullscreenRequired: checked })} />
              </div>
              <div className="space-y-1.5">
                <Label>Auto-terminate after N violations (0 = never)</Label>
                <Input type="number" min="0" value={s.proctoring?.autoTerminateAfterViolations ?? 0} onChange={(event) => patchProctoring({ autoTerminateAfterViolations: Number(event.target.value) })} />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export default ExamSettings;
