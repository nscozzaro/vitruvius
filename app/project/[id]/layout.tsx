export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex h-full min-h-screen flex-col">{children}</div>;
}
