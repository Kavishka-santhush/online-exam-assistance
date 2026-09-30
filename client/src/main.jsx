import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { ClerkProvider } from '@clerk/clerk-react';

import store from '@/store';
import App from '@/App';
import { configureApiClient } from '@/lib/apiClient';
import { configureSocket } from '@/lib/socket';

import './index.css';

/**
 * Application entry point.
 *
 * Composition order matters:
 *   1. `ClerkProvider` — owns authentication; nothing that needs a session can
 *      render above it. We intentionally do NOT wrap the whole tree in Clerk's
 *      `<SignedIn>` gate because public surfaces (exam join links, the access-
 *      code interstitial, certificate verification) must render for anonymous
 *      visitors; per-route guards inside `<App>` decide who may pass.
 *   2. A token bridge (`configureAuth`) hands Clerk's `getToken` to the axios
 *      instance and the socket singleton so every REST request and socket
 *      handshake carries the session JWT (and, via the interceptor, the active
 *      organization header).
 *   3. Redux `Provider`, then the router, then the route table.
 */

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// Wire identity → transport once, before any request fires. Clerk's `getToken`
// is exposed on `window.Clerk` after the provider mounts; the axios/socket
// layers call it lazily per request so a not-yet-ready token simply resolves to
// null (anonymous) rather than throwing at boot.
configureApiClient({ getToken: async () => (await window.Clerk?.session?.getToken()) ?? null });
configureSocket({ getToken: async () => (await window.Clerk?.session?.getToken()) ?? null });

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={publishableKey}
      // Multi-organization is driven off our own `OrganizationMembership` table,
      // so we let Clerk surface a single active session and manage org context
      // in Redux (see authSlice.switchOrganization).
      afterSignOutUrl="/"
      appearance={{
        variables: { colorPrimary: '#4f46e5', borderRadius: '0.5rem' },
        elements: { card: 'shadow-lg', headerTitle: 'text-lg font-semibold' },
      }}
    >
      <Provider store={store}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </Provider>
    </ClerkProvider>
  </React.StrictMode>,
);
