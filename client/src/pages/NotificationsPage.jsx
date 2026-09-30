import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Check, CheckCheck, Inbox, Settings2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import {
  fetchNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  selectNotifications,
  selectUnreadCount,
} from '@/store/slices/notificationSlice';
import { toast } from '@/store/slices/uiSlice';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
];

function formatWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function NotificationsPage() {
  const dispatch = useAppDispatch();
  const items = useAppSelector(selectNotifications);
  const unread = useAppSelector(selectUnreadCount);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.resolve(dispatch(fetchNotifications({}))).finally(() => setLoading(false));
  }, [dispatch]);

  const visible = filter === 'unread' ? items.filter((item) => !item.readAt) : items;

  async function handleMarkAll() {
    await dispatch(markAllNotificationsRead());
    dispatch(toast({ title: 'All caught up', description: 'Marked every notification as read.', variant: 'success' }));
  }

  function handleOpen(item) {
    if (!item.readAt) dispatch(markNotificationRead({ id: item.id, read: true }));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Exam assignments, grading updates, proctoring alerts and announcements."
        breadcrumb={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Notifications' }]}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/profile">
                <Settings2 className="mr-1.5 h-4 w-4" /> Preferences
              </Link>
            </Button>
            <Button onClick={handleMarkAll} disabled={unread === 0}>
              <CheckCheck className="mr-1.5 h-4 w-4" /> Mark all read
            </Button>
          </>
        }
      />

      <div className="flex items-center gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? 'default' : 'outline'}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key === 'unread' && unread > 0 ? (
              <Badge className="ml-2" variant="secondary">
                {unread}
              </Badge>
            ) : null}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" />}
          title={filter === 'unread' ? 'No unread notifications' : 'Your inbox is empty'}
          description="New activity will appear here in real time."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((item) => {
            const isUnread = !item.readAt;
            return (
              <Card key={item.id} className={isUnread ? 'border-primary/40 bg-primary/[0.03]' : undefined}>
                <CardContent className="flex items-start gap-3 p-4">
                  <div
                    className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg ${
                      isUnread ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <Bell className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">{item.title ?? item.type}</p>
                      {isUnread ? <span className="size-2 shrink-0 rounded-full bg-primary" /> : null}
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {formatWhen(item.createdAt)}
                      </span>
                    </div>
                    {item.body ? <p className="mt-0.5 text-sm text-muted-foreground">{item.body}</p> : null}
                    {item.linkUrl ? (
                      <Link
                        to={item.linkUrl}
                        onClick={() => handleOpen(item)}
                        className="mt-1.5 inline-block text-sm font-medium text-primary hover:underline"
                      >
                        View
                      </Link>
                    ) : null}
                  </div>
                  {isUnread ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Mark as read"
                      onClick={() => dispatch(markNotificationRead({ id: item.id, read: true }))}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
