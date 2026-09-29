import CreateTripForm from "@/components/CreateTripForm";
import MyTrips from "@/components/MyTrips";

export default function Home() {
  return (
    <div className="min-h-full flex-1 bg-background">
      <CreateTripForm />
      <MyTrips />
    </div>
  );
}
