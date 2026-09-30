import { useEffect } from 'react';
import { useAppDispatch } from './useRedux';
import { connectSocket, disconnectSocket, getSocket, onSocket } from '@/lib/socket';
import { configureApiClient, setActiveOrganization } from '@/lib/apiClient';
import { notificationReceived, announcementReceived } from '@/store/slices/notificationSlice';
import { fetchMyOrganizations } from '@/store/slices/authSlice';

/**
 * Socket connection lifecycle + shared event plumbing.
 *
 * `useSocketConnection` is mounted once (inside the authenticated shell): it
 * opens the singleton connection and wires the server events that are relevant
 * regardless of which screen the user is on — notifications, the unread badge,
 * organization context and live proctoring feed the Redux store. Feature-local
 * room events (exam state, proctor grid, live quiz) are subscribed by the
 * dedicated hooks that re-export `onSocket` here.
 */
export function useSocketConnection({ getToken, enabled = true, userId } = {}) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!enabled) return undefined;
    const socket = connectSocket();
    if (getToken) configureApiClient({ getToken });

    const offNotification = onSocket('notification:new', (payload) => dispatch(notificationReceived(payload)));
    const offAnnouncement = onSocket('announcement:new', (payload) => dispatch(announcementReceived(payload)));

    return () => {
      offNotification();
      offAnnouncement();
      // Do not fully disconnect on unmount of a screen; only the outer shell
      // unmounting (sign-out) should tear down the connection.
    };
  }, [dispatch, enabled, getToken, userId]);
}

/**
 * Re-sync organization context whenever the server tells this socket its
 * session changed (e.g. membership added by another tab).
 */
export function useSocketOrganizationSync() {
  const dispatch = useAppDispatch();
  useEffect(
    () =>
      onSocket('org:context-changed', (payload) => {
        if (payload?.organizationId) setActiveOrganization(payload.organizationId);
        dispatch(fetchMyOrganizations());
      }),
    [dispatch],
  );
}

/** Low-level subscription used by feature hooks; returns an unsubscribe fn. */
export { onSocket, getSocket, disconnectSocket };
