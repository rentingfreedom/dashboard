import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="bg-gray-900 rounded-xl px-6 py-5 mb-8 flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Renting Freedom" className="h-10 w-auto object-contain" />
        </div>
        <SignUp
          appearance={{
            elements: {
              rootBox: "w-full",
              card: "shadow-sm w-full",
            },
          }}
        />
      </div>
    </div>
  );
}
