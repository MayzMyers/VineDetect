import { ScannerPage } from "@/components/scanner/ScannerPage";

export const metadata = {
  title: "Wine scanner",
};

type Props = {
  searchParams: Promise<{ debug?: string | string[] }>;
};

export default async function ScanPage({ searchParams }: Props) {
  const params = await searchParams;
  return <ScannerPage debug={params.debug === "1"} />;
}
