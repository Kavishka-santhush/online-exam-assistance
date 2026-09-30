import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, BookOpen } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectExamList, fetchMyExams, fetchExams } from '@/store/slices/examSlice';
import { selectIsStaff, selectIsAuthor } from '@/store/slices/authSlice';
import { useDebouncedValue } from '@/hooks/useDebounce';
import { EXAM_STATUS_META } from '@/utils/examConstants';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_FILTERS = ['ALL', 'DRAFT', 'PUBLISHED', 'ACTIVE', 'CLOSED'];

export default function ExamsPage() {
  const dispatch = useAppDispatch();
  const isStaff = useAppSelector(selectIsStaff);
  const isAuthor = useAppSelector(selectIsAuthor);
  const list = useAppSelector(selectExamList);

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const debounced = useDebouncedValue(query, 300);

  useEffect(() => {
    dispatch(isStaff ? fetchMyExams({}) : fetchExams({}));
  }, [dispatch, isStaff]);

  const filtered = useMemo(() => {
    const items = list.items ?? [];
    const q = debounced.trim().toLowerCase();
    return items.filter((exam) => {
      if (status !== 'ALL' && exam.status !== status) return false;
      if (q && !`${exam.title} ${exam.description ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [list.items, debounced, status]);

  const loading = list.status === 'loading';

  return (
    <div className="space-y-6">
      <PageHeader
        title={isStaff ? 'My exams' : 'Exam catalog'}
        description={isStaff ? 'Every exam you have authored or co-authored.' : 'Exams available for you to take.'}
        actions={
          isAuthor ? (
            <Button asChild>
              <Link to="/exams/new"><Plus className="mr-1.5 h-4 w-4" /> New exam</Link>
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search exams…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((option) => (
            <Button key={option} size="sm" variant={status === option ? 'default' : 'outline'} onClick={() => setStatus(option)}>
              {option === 'ALL' ? 'All' : EXAM_STATUS_META[option]?.label ?? option}
            </Button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-6 w-6" />}
          title="No exams found"
          description={isAuthor ? 'Create your first exam to get started.' : 'Nothing matches your filters yet.'}
          action={isAuthor ? <Button asChild><Link to="/exams/new"><Plus className="mr-1.5 h-4 w-4" /> New exam</Link></Button> : null}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((exam) => {
            const meta = EXAM_STATUS_META[exam.status] ?? { label: exam.status ?? 'Draft', tone: 'muted' };
            const to = isStaff ? `/exams/${exam.id}` : `/exam/${exam.id}/take`;
            return (
              <Link key={exam.id} to={to} className="group">
                <Card className="h-full transition-shadow group-hover:shadow-md">
                  <CardContent className="flex h-full flex-col p-5">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <h3 className="font-semibold leading-snug">{exam.title}</h3>
                      <Badge variant={meta.tone === 'muted' ? 'secondary' : meta.tone}>{meta.label}</Badge>
                    </div>
                    {exam.description ? <p className="mb-4 line-clamp-2 text-sm text-muted-foreground">{exam.description}</p> : null}
                    <div className="mt-auto flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{exam.type ?? 'Exam'}</span>
                      {exam.durationMinutes ? <span>· {exam.durationMinutes} min</span> : null}
                      {exam.questionCount != null ? <span>· {exam.questionCount} questions</span> : null}
                      {exam.settings?.isProctored ? <Badge variant="outline" className="ml-auto">Proctored</Badge> : null}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
