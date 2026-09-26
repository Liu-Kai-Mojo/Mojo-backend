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
  {id:"61004",title:"Inception",genre:"Science Fiction, Action, Thriller",year:2010,duration:148,rating:8.8,description:"A thief who steals corporate secrets through dream-sharing technology is given an impossible task: planting an idea.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Inception_(2010)_theatrical_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States;United Kingdom",productionCompanies:"Warner Bros. Pictures;Legendary Pictures;Syncopy",distributor:"Warner Bros. Pictures",hollywoodEligible:true},
  {id:"61005",title:"Get Out",genre:"Horror, Mystery, Thriller",year:2017,duration:104,rating:8.0,description:"A young man visits his girlfriends family estate and discovers a disturbing conspiracy.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Get_Out_poster.png?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Blumhouse Productions;Monkeypaw Productions;QC Entertainment",distributor:"Universal Pictures",hollywoodEligible:true},
  {id:"61006",title:"Split",genre:"Psychological Thriller, Horror",year:2016,duration:117,rating:7.3,description:"Three girls are kidnapped by a man who reveals multiple distinct personalities.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Split_(2016_film)_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Blumhouse Productions;Blinding Edge Pictures",distributor:"Universal Pictures",hollywoodEligible:true},
  {id:"61007",title:"Jigsaw",genre:"Horror, Mystery, Thriller",year:2017,duration:92,rating:5.7,description:"A new series of murders appears to follow the methods of the Jigsaw Killer.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Jigsaw_2017_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Twisted Pictures",distributor:"Lionsgate Films",hollywoodEligible:true}
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
