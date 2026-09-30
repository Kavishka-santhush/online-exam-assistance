import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Activity, BarChart3, CheckCircle2, Download, Sparkles, Timer, TrendingUp } from 'lucide-react';
import { useAppDispatch } from '@/hooks/useRedux';
import { fetchMyExams } from '@/store/slices/examSlice';
import { request, endpoints } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { downloadFromEndpoint } from '@/utils/download';
import { metaFor } from '@/utils/questionTypes';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const PIE_COLORS = ['#22c55e', '#ef4444'];

/**
 * Analytics (`/analytics` and `/analytics/:examId`).
 *
 * Two shapes on one page: without an exam id it's the organization roll-up
 * (headline counts), with one it drills into that exam's overview, score
 * histogram, and per-question difficulty. Every number is computed by the
 * server (`/analytics/*`) — this view only charts what the API returns and
 * never aggregates raw attempts client-side, so org-wide and exam-wide
 * figures can't diverge from the source of truth. The exam picker lets a
 * grader pivot between their exams without leaving the page.
 */
export default function AnalyticsPage() {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const { examId } = useParams();

  const [org, setOrg] = useState(null);
  const [overview, setOverview] = useState(null);
  const [distribution, setDistribution] = useState(null);
  const [questions, setQuestions] = useState(null);
  const [exams, setExams] = useState([]);

  useEffect(() => {
    dispatch(fetchMyExams({ limit: 100 })).then((result) => {
      if (result?.payload?.items) setExams(result.payload.items);
    });
  }, [dispatch]);

  useEffect(() => {
    let alive = true;
    setOverview(null); setDistribution(null); setQuestions(null);
    if (!examId) {
      request.get(endpoints.analytics.organization).then((data) => alive && setOrg(data)).catch(() => {});
      return () => { alive = false; };
    }
    setOrg(null);
    Promise.all([
      request.get(endpoints.analytics.examOverview(examId)),
      request.get(endpoints.analytics.scoreDistribution(examId)),
      request.paged(endpoints.analytics.questions(examId), { params: { limit: 100 } }).then(({ data }) => data),
    ])
      .then(([ov, dist, qs]) => {
        if (!alive) return;
        setOverview(ov); setDistribution(dist); setQuestions(qs);
      })
      .catch((err) => alive && toast.error('Could not load analytics', err.message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  const distData = useMemo(
    () => (distribution?.bins ?? []).map((bin) => ({ name: bin.range.replace('-%', ''), count: bin.count })),
    [distribution],
  );

  const passSplit = useMemo(() => {
    if (!overview) return [];
    const passed = overview.passedCount ?? 0;
    const graded = overview.graded ?? 0;
    return [
      { name: 'Passed', value: passed },
      { name: 'Failed', value: Math.max(0, graded - passed) },
    ];
  }, [overview]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description={examId ? overview?.exam?.title ?? 'Exam performance' : 'Organization-wide snapshot'}
        breadcrumb={[{ label: 'Analytics' }]}
        actions={
          examId ? (
            <Button variant="outline" size="sm" onClick={() => downloadFromEndpoint(endpoints.analytics.exportAnalytics(examId), `analytics-${examId}.csv`).catch(() => toast.error('Export failed'))}>
              <Download className="mr-1.5 h-4 w-4" /> Export
            </Button>
          ) : null
        }
      />

      {/* exam switcher */}
      <ExamsPicker exams={exams} value={examId} />

      {!examId ? <OrgRollup org={org} /> : (
        <div className="space-y-6">
          {/* headline stat cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={Activity} label="Attempts" value={overview?.totalAttempts} loading={!overview} hint={`${overview?.inProgress ?? 0} in progress`} />
            <StatCard icon={CheckCircle2} label="Pass rate" value={overview ? `${overview.passRate}%` : null} loading={!overview} hint={`${overview?.passedCount ?? 0}/${overview?.graded ?? 0} graded`} tone="success" />
            <StatCard icon={TrendingUp} label="Average score" value={overview ? `${overview.averageScore}%` : null} loading={!overview} hint={overview?.exam?.passingPercent != null ? `pass mark ${overview.exam.passingPercent}%` : ''} />
            <StatCard icon={Timer} label="Avg. time" value={overview ? formatDuration(overview.averageTimeSec) : null} loading={!overview} hint={`${overview?.completionRate ?? 0}% completed`} />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            {/* score histogram */}
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="h-4 w-4" /> Score distribution</CardTitle></CardHeader>
              <CardContent className="h-72">
                {!distribution ? <Skeleton className="h-full w-full" /> : distData.every((d) => d.count === 0) ? <EmptyChart label="No graded attempts yet." /> : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={distData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} fontSize={11} tickLine={false} axisLine={false} />
                      <Tooltip cursor={{ fill: 'hsl(var(--muted))' }} />
                      <Bar dataKey="count" name="Candidates" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* pass/fail donut */}
            <Card>
              <CardHeader><CardTitle className="text-base">Outcome</CardTitle></CardHeader>
              <CardContent className="h-72">
                {!overview ? <Skeleton className="h-full w-full" /> : passSplit.every((s) => s.value === 0) ? <EmptyChart label="Nothing graded yet." /> : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={passSplit} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                        {passSplit.map((entry, index) => <Cell key={entry.name} fill={PIE_COLORS[index]} />)}
                      </Pie>
                      <Legend />
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* per-question difficulty */}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> Question difficulty</CardTitle></CardHeader>
            <CardContent className="p-0">
              {!questions ? <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div> : questions.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No question stats yet.</p> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Question</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Attempts</TableHead>
                      <TableHead className="text-right">Correct %</TableHead>
                      <TableHead className="w-32">Discrimination</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {questions.map((q) => {
                      const pct = q.attempts > 0 ? Math.round((q.correctCount / q.attempts) * 100) : null;
                      return (
                        <TableRow key={q.questionId}>
                          <TableCell className="text-muted-foreground">{q.order}</TableCell>
                          <TableCell className="max-w-[320px] truncate">{q.prompt}</TableCell>
                          <TableCell><Badge variant="outline">{metaFor(q.type).label}</Badge></TableCell>
                          <TableCell className="text-right tabular-nums">{q.attempts}</TableCell>
                          <TableCell className={`text-right font-medium tabular-nums ${pct == null ? 'text-muted-foreground' : pct < 40 ? 'text-destructive' : pct > 80 ? 'text-emerald-600' : ''}`}>{pct == null ? '—' : `${pct}%`}</TableCell>
                          <TableCell><DifficultyBar value={pct} /></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function OrgRollup({ org }) {
  const cards = [
    { icon: BarChart3, label: 'Exams', value: org?.totalExams, hint: `${org?.activeExams ?? 0} active` },
    { icon: Activity, label: 'Attempts', value: org?.totalAttempts, hint: `${org?.gradedAttempts ?? 0} graded` },
    { icon: CheckCircle2, label: 'Pass rate', value: org ? `${org.overallPassRate}%` : null, tone: 'success' },
    { icon: TrendingUp, label: 'Certificates', value: org?.certificatesIssued, hint: 'issued' },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => <StatCard key={card.label} loading={!org} {...card} />)}
      <Card className="sm:col-span-2 lg:col-span-4">
        <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
          <Timer className="h-4 w-4" /> Total proctoring violations recorded: <span className="font-semibold text-foreground">{org?.totalViolations ?? '—'}</span>
        </CardContent>
      </Card>
    </div>
  );
}

function ExamsPicker({ exams, value }) {
  // A "0" pseudo-id marks the org-wide view; the select drives the route.
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Exam:</span>
      <ExamSelect exams={exams} value={value} />
    </div>
  );
}

// Thin wrapper so the router (not local state) is the source of the selection.
function ExamSelect({ exams, value }) {
  const navigate = useNavigate();
  return (
    <Select value={value ?? '__org__'} onValueChange={(next) => navigate(next === '__org__' ? '/analytics' : `/analytics/${next}`)}>
      <SelectTrigger className="w-[260px]"><SelectValue placeholder="All organization" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__org__">All organization</SelectItem>
        {exams.map((exam) => <SelectItem key={exam.id} value={exam.id}>{exam.title}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function StatCard({ icon: Icon, label, value, hint, loading, tone }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{label}</p>
          <Icon className={`h-4 w-4 ${tone === 'success' ? 'text-emerald-500' : 'text-muted-foreground'}`} />
        </div>
        {loading || value == null ? <Skeleton className="mt-1 h-8 w-16" /> : <p className="text-2xl font-bold">{value}</p>}
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function DifficultyBar({ value }) {
  if (value == null) return null;
  const color = value < 40 ? 'bg-destructive' : value > 80 ? 'bg-emerald-500' : 'bg-amber-500';
  return <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className={`h-full ${color}`} style={{ width: `${value}%` }} /></div>;
}

function EmptyChart({ label }) {
  return <div className="grid h-full place-items-center text-sm text-muted-foreground">{label}</div>;
}

function formatDuration(sec) {
  if (!sec) return '—';
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
