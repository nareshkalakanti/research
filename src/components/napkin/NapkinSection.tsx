export function NapkinSection({
  id,
  title,
  eyebrow,
  children,
}: {
  id: string;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="napkin-section">
      <header className="napkin-section-head">
        {title}
        {eyebrow ? <span className="napkin-eyebrow">{eyebrow}</span> : null}
      </header>
      <div className="napkin-section-body">{children}</div>
    </section>
  );
}
