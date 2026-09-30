import { Link } from 'react-router-dom';
import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { ShieldCheck, Webcam, Brain, BarChart3, FileCheck2, Globe2, Zap, Users2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const FEATURES = [
  { icon: FileCheck2, title: 'Every question type', body: 'MCQ, essay, coding in Monaco, hotspot, math with KaTeX, drag-and-drop matching and more.' },
  { icon: Webcam, title: 'Live proctoring', body: 'Webcam + screen share over WebRTC, AI face/voice detection, and a real-time proctor watch grid.' },
  { icon: ShieldCheck, title: 'Browser lockdown', body: 'Tab-switch, copy-paste, right-click and DevTools detection with automatic violation logging.' },
  { icon: Brain, title: 'AI-assisted', body: 'Generate questions, grade essays, and summarise exam analytics — powered by OpenRouter.' },
  { icon: BarChart3, title: 'Deep analytics', body: 'Discrimination & difficulty indices, item analysis, cohort comparisons and exportable reports.' },
  { icon: FileCheck2, title: 'Verifiable certificates', body: 'Issue tamper-evident certificates with a public verification URL and QR code.' },
  { icon: Users2, title: 'Live quizzes', body: 'Kahoot-style real-time sessions with a leaderboard for up to hundreds of simultaneous players.' },
  { icon: Globe2, title: 'Multilingual & accessible', body: 'Per-exam languages, high-contrast mode, adjustable font size and screen-reader support.' },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2 font-semibold">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground font-bold">E</span>
            ExamFlow
          </div>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#features" className="hover:text-foreground">Features</a>
            <Link to="/pricing" className="hover:text-foreground">Pricing</Link>
            <a href="#proctoring" className="hover:text-foreground">Proctoring</a>
          </nav>
          <div className="flex items-center gap-2">
            <SignedOut>
              <Button asChild variant="ghost" size="sm">
                <Link to="/sign-in">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/sign-up">Get started</Link>
              </Button>
            </SignedOut>
            <SignedIn>
              <Button asChild size="sm">
                <Link to="/dashboard">Open dashboard</Link>
              </Button>
            </SignedIn>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 py-20 text-center">
        <Badge variant="secondary" className="mb-5 gap-1.5">
          <Zap className="h-3.5 w-3.5" /> Online exams, proctoring &amp; certification in one platform
        </Badge>
        <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">
          Run secure online assessments at any scale
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
          Build any question type, proctor with live AI monitoring, grade with automation, and issue
          verifiable certificates — for quizzes, mock exams, certifications and surveys.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <SignedOut>
            <Button asChild size="lg">
              <Link to="/sign-up">Start free</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/pricing">See pricing</Link>
            </Button>
          </SignedOut>
          <SignedIn>
            <Button asChild size="lg">
              <Link to="/exams/new">Create an exam</Link>
            </Button>
          </SignedIn>
        </div>

        <dl className="mx-auto mt-14 grid max-w-3xl grid-cols-2 gap-6 sm:grid-cols-4">
          {[['16+', 'question types'], ['Live', 'WebRTC proctoring'], ['AI', 'grading & gen'], ['100%', 'self-hosted uploads']].map(([stat, label]) => (
            <div key={label}>
              <dt className="text-3xl font-black text-primary">{stat}</dt>
              <dd className="mt-1 text-sm text-muted-foreground">{label}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="features" className="border-t bg-muted/30 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-3xl font-bold tracking-tight">Everything you need to assess online</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            A complete assessment stack — no plugins, no vendor sprawl.
          </p>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <Card key={f.title} className="transition-shadow hover:shadow-md">
                <CardContent className="p-5">
                  <div className="mb-3 grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                    <f.icon className="h-5 w-5" />
                  </div>
                  <h3 className="font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section id="proctoring" className="py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 md:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Proctoring that keeps integrity honest</h2>
            <p className="mt-4 text-muted-foreground">
              Candidates pass a system check, ID verification and a 360° environment scan before the clock
              starts. During the exam, faces, voices, tab-switches and clipboard access are detected and
              streamed to a proctor watch grid with one-click pause, extra-time and termination.
            </p>
            <ul className="mt-5 space-y-2 text-sm">
              {['Face & multiple-person detection', 'Screen + webcam via WebRTC', 'Auto-flag thresholds & audit log', 'Two-way proctor chat'].map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" /> {item}
                </li>
              ))}
            </ul>
          </div>
          <Card>
            <CardContent className="space-y-3 p-6">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">Live watch grid</span>
                <Badge variant="success">42 monitoring</Badge>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="aspect-video rounded-md bg-muted">
                    <div className={`flex h-full items-center justify-center text-xs ${i === 2 ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {i === 2 ? '⚠ flag' : `cam ${i + 1}`}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="border-t bg-primary py-16 text-primary-foreground">
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-6 px-4 text-center">
          <h2 className="text-3xl font-bold">Ready to run your first exam?</h2>
          <p className="max-w-xl opacity-90">Set up in minutes. Bring your own questions or generate them with AI.</p>
          <SignedIn>
            <Button asChild size="lg" variant="secondary">
              <Link to="/exams/new">Create an exam</Link>
            </Button>
          </SignedIn>
          <SignedOut>
            <Button asChild size="lg" variant="secondary">
              <Link to="/sign-up">Get started free</Link>
            </Button>
          </SignedOut>
        </div>
      </section>

      <footer className="border-t py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-sm text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} ExamFlow — Online Exam &amp; Assessment Platform</span>
          <div className="flex gap-4">
            <Link to="/pricing" className="hover:text-foreground">Pricing</Link>
            <Link to="/verify" className="hover:text-foreground">Verify a certificate</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
