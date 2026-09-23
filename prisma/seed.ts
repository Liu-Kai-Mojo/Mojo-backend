import "dotenv/config";
import { PrismaClient, Role, IdentifierType } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const ownerIdentifier = process.env.OWNER_IDENTIFIER;
const ownerPassword = process.env.OWNER_PASSWORD;

if (!ownerIdentifier || !ownerPassword) {
  throw new Error(
    "OWNER_IDENTIFIER and OWNER_PASSWORD must be set in .env"
  );
}

const passwordHash = await bcrypt.hash(ownerPassword, 12);

const owner = await prisma.user.upsert({
  where: {
    identifier: ownerIdentifier,
  },
  update: {
    name: "Studio Owner",
    passwordHash,
    role: Role.OWNER,
    active: true,
  },
  create: {
    id: "51004",
    name: "Studio Owner",
    identifier: ownerIdentifier,
    identifierType: IdentifierType.EMAIL,
    passwordHash,
    role: Role.OWNER,
    active: true,
  },
});

const movies = [
  {
    id: "61001",
    title: "Midnight Horizon",
    genre: "Adventure",
    year: 2026,
    duration: 128,
    rating: 8.7,
    description:
      "A luminous journey through a city that never sleeps.",
    posterUrl: "/assets/poster.png",
    published: true,
  },
  {
    id: "61002",
    title: "Neon Hearts",
    genre: "Romance",
    year: 2026,
    duration: 112,
    rating: 8.2,
    description:
      "Two lives cross beneath a city of neon.",
    posterUrl: "/assets/poster.png",
    published: true,
  },
  {
    id: "61003",
    title: "Last Frame",
    genre: "Mystery",
    year: 2025,
    duration: 119,
    rating: 7.9,
    description:
      "One final frame changes everything.",
    posterUrl: "/assets/poster.png",
    published: true,
  },
];

for (const movie of movies) {
  await prisma.movie.upsert({
    where: {
      id: movie.id,
    },
    update: movie,
    create: movie,
  });
}

console.log(`Seed complete. Owner: ${owner.identifier}`);

await prisma.$disconnect();
