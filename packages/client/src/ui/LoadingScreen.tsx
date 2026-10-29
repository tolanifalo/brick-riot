export function LoadingScreen() {
  return (
    <main className="loading-screen" aria-busy="true">
      <div className="loading-bricks" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <p className="loading-label">LOADING</p>
    </main>
  );
}
