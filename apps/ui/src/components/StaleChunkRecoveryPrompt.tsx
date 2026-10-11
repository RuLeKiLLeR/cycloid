export function StaleChunkRecoveryPrompt() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-0 p-8 text-center">
      <h1 className="font-display text-3xl text-text-primary">Update required.</h1>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="control-md rounded-md bg-accent px-5 text-base font-medium text-surface-0 transition-colors duration-200 hover:bg-accent-hover"
      >
        Reload
      </button>
    </div>
  );
}
