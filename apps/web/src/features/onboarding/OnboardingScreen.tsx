// PLACEHOLDER: implemented by the ui-trackers teammate.
export function OnboardingScreen({ onComplete }: { onComplete: () => void }) {
  return (
    <div className="boot">
      <div className="boot-mark" aria-hidden="true">
        <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </div>
      <h1 style={{ fontSize: 28, letterSpacing: '-0.03em' }}>Welcome to deUrge</h1>
      <p className="mut" style={{ maxWidth: 340, fontSize: 15, lineHeight: 1.5 }}>
        A private, local-first place to track abstinence, lapses, urges and the progress that continues through all of
        it.
      </p>
      <button type="button" className="btn btn-primary" onClick={onComplete}>
        Get started
      </button>
    </div>
  );
}
