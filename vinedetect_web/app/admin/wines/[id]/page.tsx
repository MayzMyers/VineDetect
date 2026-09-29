import { AdminWineDetailPage } from "@/components/admin/AdminWineDetailPage";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export const metadata = {
  title: "Wine detail | VineDetect Admin",
};

export default async function WineDetailPage({ params }: Props) {
  const { id } = await params;
  return <AdminWineDetailPage wineId={Number(id)} />;
}
