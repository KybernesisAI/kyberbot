/**
 * Placeholder view for tabs not yet implemented.
 */

interface PlaceholderViewProps {
  title: string;
  description?: string;
}

export default function PlaceholderView({ title, description }: PlaceholderViewProps) {
  return (
    <div className="h-full flex flex-col items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
      <span className="section-title mb-2" style={{ color: 'var(--accent-emerald)' }}>
        {`// ${title.toUpperCase()}`}
      </span>
      <span className="text-[11px]" style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
        {description ?? 'Coming soon'}
      </span>
    </div>
  );
}
