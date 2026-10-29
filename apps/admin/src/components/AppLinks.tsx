import { otherApps, type OtherApp } from '../apps';

/**
 * 왼쪽 아래 "다른 화면" — 시연 때 어드민에서 다른 앱으로 건너간다(보강 5, decisions/0067). 주소는 apps.ts 한 곳.
 * 새 탭으로 연다. localhost에서는 포트가 달라도 로그인 쿠키(sid)가 하나라, 다른 화면에서 로그인하면 이 화면의 세션이 끝난다(보강 3 기록).
 */
export function AppLinks({ apps = otherApps() }: { apps?: OtherApp[] }) {
  return (
    <nav className="other-apps" aria-label="다른 화면">
      <h2>다른 화면</h2>
      <ul className="plain">
        {apps.map((app) => (
          <li key={app.key}>
            {app.url ? (
              <a href={app.url} target="_blank" rel="noreferrer">
                {app.label}
              </a>
            ) : (
              <span className="muted">{app.label}(준비 중)</span>
            )}
            <div className="hint">{app.who}</div>
          </li>
        ))}
      </ul>
      <p className="hint">같은 브라우저에서 다른 화면에 로그인하면 이 화면의 로그인이 끝납니다(쿠키 공유). 다른 계정으로 동시에 보려면 브라우저 프로필을 나누세요.</p>
    </nav>
  );
}
