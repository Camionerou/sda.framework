export default function WorkspaceDocumentLoading() {
  return (
    <>
      <main className="center">
        <div className="glass topbar skeleton" style={{ height: 50 }} />
        <div className="stage skeleton" style={{ display: "block" }} />
      </main>
      <aside className="glass inspector skeleton" style={{ minHeight: 0 }} />
    </>
  );
}
