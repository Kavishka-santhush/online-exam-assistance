import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';
import {
  BookOpen,
  ClipboardList,
  Eye,
  LayoutDashboard,
  Plus,
  ShieldCheck,
  Users2,
  Bell,
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectExamList, fetchMyExams, fetchExams } from '@/store/slices/examSlice';
import { selectUnreadCount } from '@/store/slices/notificationSlice';
import {
  selectUser,
  selectIsAuthor,
  selectIsStaff,
  selectIsProctor,
  selectActiveOrganization,
} from '@/store/slices/authSlice';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const EXAM_STATUS_LABEL = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  ARCHIVED: 'Archived',
};

function statusVariant(status) {
  switch (status) {
    case 'PUBLISHED':
    case 'ACTIVE':
      return 'success';
    case 'SCHEDULED':
      return 'default';
    case 'CLOSED':
    case 'ARCHIVED':
      return 'secondary';
    default:
      return 'outline';
  }
}

export default function DashboardPage() {
  const dispatch = useAppDispatch();
  const { user } = useUser();
  const profile = useAppSelector(selectUser);
  const isAuthor = useAppSelector(selectIsAuthor);
  const isStaff = useAppSelector(selectIsStaff);
  const isProctor = useAppSelector(selectIsProctor);
  const activeOrg = useAppSelector(selectActiveOrganization);
  const unread = useAppSelector(selectUnreadCount);
  const examList = useAppSelector(selectExamList);

  // Author/staff dashboards are about *their* content, so pull `/exams/mine`;
  // a pure candidate sees the catalog of exams available to them instead.
  useEffect(() => {
    if (isStaff) dispatch(fetchMyExams({ limit: 6 }));
    else dispatch(fetchExams({ limit: 6 }));
  }, [dispatch, isStaff]);

  const firstName = profile?.firstName || user?.firstName || user?.username || 'there';
  const exams = examList.items ?? [];
  const loading = examList.status === 'loading';

  const stats = [
    { icon: BookOpen, label: isStaff ? 'Your exams' : 'Available exams', value: exams.length },
    { icon: isStaff ? ClipboardList : Users2, label: isStaff ? 'To review' : 'In progress', value: isStaff ? exams.filter((e) => e.status === 'PUBLISHED').length : 0 },
    { icon: ShieldCheck, label: 'Proctoring', value: isProctor ? 'Available' : '—' },
    { icon: Bell, label: 'Unread alerts', value: unread },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description={
          activeOrg?.name
            ? `You're working in ${activeOrg.name}.`
            : 'Here is what is happening across your assessments.'
        }
        actions={
          isAuthor ? (
            <Button asChild>
              <Link to="/exams/new">
                <Plus className="mr-1.5 h-4 w-4" /> New exam
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="flex items-center gap-4 p-5">
              <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <stat.icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm text-muted-foreground">{stat.label}</p>
                <p className="text-2xl font-bold">{stat.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{isStaff ? 'Your recent exams' : 'Recommended for you'}</h2>
            <Button asChild variant="ghost" size="sm">
              <Link to="/exams">
                View all <Eye className="ml-1.5 h-4 w-4" />
              </Link>
            </Button>
          </div>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          ) : exams.length === 0 ? (
            <EmptyState
              icon={<LayoutDashboard className="h-6 w-6" />}
              title={isStaff ? 'No exams yet' : 'Nothing scheduled right now'}
              description={
                isAuthor
                  ? 'Create your first exam to see it here.'
                  : 'When an instructor assigns you an exam, it will show up here.'
              }
              action={
                isAuthor ? (
                  <Button asChild>
                    <Link to="/exams/new">
                      <Plus className="mr-1.5 h-4 w-4" /> Create exam
                    </Link>
                  </Button>
                ) : null
              }
            />
          ) : (
            <div className="space-y-3">
              {exams.map((exam) => (
                <Card key={exam.id} className="transition-shadow hover:shadow-md">
                  <CardContent className="flex items-center justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <Link
                        to={isStaff ? `/exams/${exam.id}` : `/exam/${exam.id}/take`}
                        className="truncate font-medium hover:underline"
                      >
                        {exam.title}
                      </Link>
                      <p className="mt-0.5 truncate text-sm text-muted-foreground">
                        {exam.durationMinutes ? `${exam.durationMinutes} min` : '—'}
                        {exam.questionCount != null ? ` · ${exam.questionCount} questions` : ''}
                      </p>
                    </div>
                    <Badge variant={statusVariant(exam.status)}>
                      {EXAM_STATUS_LABEL[exam.status] ?? exam.status ?? 'Draft'}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Quick actions</h2>
          <Card>
            <CardContent className="grid gap-2 p-4">
              {isAuthor ? (
                <Button asChild variant="outline" className="justify-start">
                  <Link to="/exams/new">
                    <Plus className="mr-2 h-4 w-4" /> Build an exam
                  </Link>
                </Button>
              ) : null}
              {isStaff ? (
                <>
                  <Button asChild variant="outline" className="justify-start">
                    <Link to="/grading">
                      <ClipboardList className="mr-2 h-4 w-4" /> Grading queue
                    </Link>
                  </Button>
                  <Button asChild variant="outline" className="justify-start">
                    <Link to="/question-banks">
                      <BookOpen className="mr-2 h-4 w-4" /> Question banks
                    </Link>
                  </Button>
                </>
              ) : null}
              {isProctor ? (
                <Button asChild variant="outline" className="justify-start">
                  <Link to="/exams">
                    <ShieldCheck className="mr-2 h-4 w-4" /> Proctor a session
                  </Link>
                </Button>
              ) : null}
              <Button asChild variant="outline" className="justify-start">
                <Link to="/notifications">
                  <Bell className="mr-2 h-4 w-4" /> Notifications
                  {unread > 0 ? (
                    <Badge className="ml-auto" variant="destructive">
                      {unread}
                    </Badge>
                  ) : null}
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link to="/profile">
                  <Users2 className="mr-2 h-4 w-4" /> Your profile
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
