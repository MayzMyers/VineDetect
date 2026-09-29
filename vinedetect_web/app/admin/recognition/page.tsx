import { AdminRecognitionListPage } from "@/components/admin/AdminRecognitionListPage";
import { Suspense } from "react";

export const metadata = {
  title: "Recognition Admin | VineDetect",
};

export default function RecognitionAdminPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-zinc-100 p-6 text-sm text-zinc-500">Loading recognition inventory...</main>}>
      <AdminRecognitionListPage />
    </Suspense>
  );
}
