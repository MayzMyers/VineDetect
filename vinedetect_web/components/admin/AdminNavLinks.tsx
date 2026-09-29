import Link from "next/link";

type Props = {
  active?: "catalog" | "recognition" | "annotations" | "jobs" | "training";
};

export function AdminNavLinks({ active }: Props) {
  return (
    <nav className="flex flex-wrap gap-3 text-sm font-medium">
      <NavLink href="/admin" active={active === "catalog"} label="Catalog" />
      <NavLink href="/admin/recognition" active={active === "recognition"} label="Recognition" />
      <NavLink href="/admin/recognition/annotations" active={active === "annotations"} label="Annotations" />
      <NavLink href="/admin/recognition/jobs" active={active === "jobs"} label="Jobs" />
      <NavLink href="/admin/recognition/training" active={active === "training"} label="Training" />
    </nav>
  );
}

function NavLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link href={href} className={active ? "text-zinc-950" : "text-zinc-600 hover:text-zinc-950"}>
      {label}
    </Link>
  );
}
