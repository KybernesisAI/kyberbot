/**
 * Frameless title bar with macOS-style traffic light placeholder.
 */

export default function TitleBar() {
  const kb = (window as any).kyberbot;

  return (
    <div
      className="flex items-center h-9 px-3 bg-[#0a0a0a] border-b select-none"
      style={{
        WebkitAppRegion: 'drag' as any,
        borderColor: 'rgba(255, 255, 255, 0.08)',
      }}
    >
      {/* Spacer for macOS traffic lights (hiddenInset gives us native buttons) */}
      <div className="w-[70px] flex-shrink-0" />

      {/* Title */}
      <div className="flex-1 text-center">
        <span
          className="text-[9px] tracking-[2px] uppercase"
          style={{ color: 'var(--fg-tertiary)', fontFamily: 'var(--font-mono)' }}
        >
          KyberBot
        </span>
      </div>

      {/* Right spacer for symmetry */}
      <div className="w-[70px] flex-shrink-0" />
    </div>
  );
}
