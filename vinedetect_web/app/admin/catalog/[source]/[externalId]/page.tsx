import { redirect } from "next/navigation";

type Props = {
  params: Promise<{
    source: string;
    externalId: string;
  }>;
};

export const metadata = {
  title: "Catalog detail | VineDetect Admin",
};

export default async function CatalogDetailPage({ params }: Props) {
  const { source, externalId } = await params;
  redirect(
    `/admin/recognition/${encodeURIComponent(decodeURIComponent(source))}/${encodeURIComponent(
      decodeURIComponent(externalId)
    )}?section=catalog`
  );
}
