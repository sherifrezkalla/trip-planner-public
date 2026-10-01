import Link from "next/link";
import CreateTripForm from "@/components/CreateTripForm";
import MyTrips from "@/components/MyTrips";

export default function Home() {
  return (
    <div className="min-h-full flex-1 bg-background">
      <aside className="mx-auto mb-6 max-w-md rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-5">
        <p className="font-semibold">New to Trip Planner?</p>
        <p className="mt-1 text-sm text-[#62594B]">Explore a fictional day and try a group decision. No account or setup needed.</p>
        <Link href="/demo" className="mt-3 inline-flex min-h-11 items-center font-semibold text-[#A84A15] underline underline-offset-4">Try the fictional demo →</Link>
      </aside>
      <CreateTripForm />
      <MyTrips />
    </div>
  );
}
