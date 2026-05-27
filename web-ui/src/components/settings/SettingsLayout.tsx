import Link from "next/link";

const links = [
  { href: "/settings/models", label: "Models" },
  { href: "/settings/imagegen", label: "Image Gen" },
  { href: "/settings/skills", label: "Skills" },
  { href: "/settings/auth", label: "Auth" },
  { href: "/settings/config", label: "Config" },
  { href: "/settings/workspace", label: "Workspace" },
];

export function SettingsLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="page-wrap">
      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="page-card h-fit">
          <h2 className="mb-3 text-sm font-semibold">Settings</h2>
          <nav className="space-y-1">
            {links.map((link) => (
              <Link key={link.href} href={link.href} className="nav-row">
                {link.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="page-card">
          <h1 className="text-xl font-semibold">{title}</h1>
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </section>
  );
}
