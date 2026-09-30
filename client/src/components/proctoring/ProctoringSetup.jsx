import { useCallback, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Camera, ShieldCheck, Loader2 } from 'lucide-react';
import { useAppDispatch } from '@/hooks/useRedux';
import { completeProctorSetup } from '@/store/slices/proctoringSlice';
import { useCapabilities } from '@/hooks/useCapabilities';
import { PROCTOR_SETUP_STEPS } from '@/utils/proctoringConstants';
import { readFileAsDataUrl } from '@/utils/download';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Candidate pre-exam proctoring gate.
 *
 * Walks `PROCTOR_SETUP_STEPS` and only lets the candidate "Begin exam" once the
 * capabilities the *exam* requires (camera / mic / screen-share, read from the
 * exam's `proctoring` settings) have been granted and the agreement is ticked.
 * It captures a selfie + ID photo as data URLs and posts them to
 * `POST /proctoring/:attempt/setup/complete`; a human proctor then moves the
 * status to APPROVED (pushed back down the `proctor:*` socket events), which is
 * what unlocks the actual exam runtime in `TakeExamPage`.
 */
export function ProctoringSetup({ attemptId, requirements = {}, onReady }) {
  const dispatch = useAppDispatch();
  const { capabilities, runChecks } = useCapabilities();
  const videoRef = useRef(null);
  const [selfie, setSelfie] = useState(null);
  const [idPhoto, setIdPhoto] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const requireCamera = requirements.requireCamera !== false;
  const requireMic = requirements.requireMicrophone === true;
  const requireScreen = requirements.requireScreenShare === true;

  const doChecks = useCallback(() => runChecks({ checkCamera: requireCamera, checkMicrophone: requireMic, checkScreenShare: requireScreen }), [runChecks, requireCamera, requireMic, requireScreen]);

  const captureSelfie = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      canvas.getContext('2d').drawImage(videoRef.current, 0, 0);
      setSelfie(canvas.toDataURL('image/jpeg', 0.7));
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await dispatch(completeProctorSetup({ attemptId, payload: { selfie, idPhoto, agreement: true, capabilities } }));
    setBusy(false);
    if (completeProctorSetup.fulfilled.match(result)) onReady?.(result.payload);
    else setError(result.payload?.message ?? 'Setup submission failed');
  }

  const systemOk = capabilities.checked && capabilities.webRtc === 'ok' && (!requireCamera || capabilities.camera === 'granted') && (!requireMic || capabilities.microphone === 'granted') && (!requireScreen || capabilities.screenShare === 'granted');
  const canBegin = systemOk && (!requireCamera || Boolean(selfie)) && agreed;

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /> Proctoring setup</CardTitle>
        <CardDescription>Complete each check to unlock your exam. Your camera feed is reviewed by a proctor before you begin.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ul className="space-y-3">
          {PROCTOR_SETUP_STEPS.map((step) => {
            const done =
              step.key === 'system' ? systemOk
                : step.key === 'face' ? Boolean(selfie)
                  : step.key === 'id' ? Boolean(idPhoto)
                    : step.key === 'agreement' ? agreed
                      : systemOk; // environment: piggybacks on camera grant for the browser-only build
            return (
              <li key={step.key} className="flex items-start gap-3">
                {done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground/40" />}
                <div className="flex-1">
                  <p className="font-medium">{step.label}</p>
                  <p className="text-sm text-muted-foreground">{step.description}</p>
                </div>
                {step.key === 'system' ? (
                  <Button size="sm" variant="outline" onClick={doChecks} disabled={busy}>Run check</Button>
                ) : null}
                {step.key === 'face' ? (
                  <Button size="sm" variant="outline" onClick={captureSelfie} disabled={!systemOk || busy}>
                    <Camera className="mr-1 h-4 w-4" /> Capture
                  </Button>
                ) : null}
                {step.key === 'id' ? (
                  <Input type="file" accept="image/*" className="h-9 w-44 text-xs" onChange={async (event) => { const file = event.target.files?.[0]; if (file) setIdPhoto(await readFileAsDataUrl(file)); }} />
                ) : null}
                {step.key === 'agreement' ? (
                  <div className="flex items-center gap-2">
                    <Checkbox id="agree" checked={agreed} onCheckedChange={(checked) => setAgreed(checked === true)} />
                    <Label htmlFor="agree" className="cursor-pointer text-sm font-normal">I agree</Label>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        <video ref={videoRef} className={cn('hidden')} muted playsInline />
        {selfie ? <img src={selfie} alt="selfie" className="h-20 rounded-md border" /> : null}

        {capabilities.checked ? (
          <div className="flex flex-wrap gap-2 text-xs">
            <StatusChip label="WebRTC" ok={capabilities.webRtc === 'ok'} />
            <StatusChip label="Camera" ok={capabilities.camera === 'granted'} skipped={!requireCamera && capabilities.camera === 'skipped'} />
            <StatusChip label="Mic" ok={capabilities.microphone === 'granted'} skipped={!requireMic} />
            <StatusChip label="Screen" ok={capabilities.screenShare === 'granted'} skipped={!requireScreen} />
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Button className="w-full" size="lg" onClick={submit} disabled={!canBegin || busy}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Submit for approval
        </Button>
      </CardContent>
    </Card>
  );
}

function StatusChip({ label, ok, skipped }) {
  const tone = skipped ? 'muted' : ok ? 'ok' : 'bad';
  return (
    <span className={cn('rounded-full border px-2 py-0.5', tone === 'ok' && 'border-emerald-500/40 text-emerald-600', tone === 'bad' && 'border-destructive/40 text-destructive', tone === 'muted' && 'text-muted-foreground')}>
      {label}: {skipped ? 'n/a' : ok ? 'ready' : 'required'}
    </span>
  );
}

export default ProctoringSetup;
