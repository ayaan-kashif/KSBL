import { cookies } from 'next/headers';
import TopNav from '@/components/TopNav';
import Sidebar from '@/components/Sidebar';
import { verifySession, ADMIN_SESSION_COOKIE, type AdminSessionPayload } from '@/lib/auth';
import styles from './desktoplayout.module.css';

/**
 * Renders the portal chrome (sidebar + top nav) only for a signed-in admin.
 *
 * /settings is deliberately reachable while logged out because it hosts the
 * admin login form — but wrapping that form in the full dashboard shell
 * advertised navigation the visitor can't actually use. Gating the chrome here
 * (rather than inside the page) keeps every other (desktop) route unchanged.
 */
export default async function DesktopLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  const session = token ? await verifySession<AdminSessionPayload>(token) : null;
  const isAdmin = session?.role === 'admin';

  if (!isAdmin) {
    return <div className={styles.bareLayout}>{children}</div>;
  }

  return (
    <div className={styles.layout}>
      <TopNav />
      <Sidebar />
      <main className={styles.main}>
        {children}
      </main>
    </div>
  );
}
