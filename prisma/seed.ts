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
  {id:"61007",title:"Jigsaw",genre:"Horror, Mystery, Thriller",year:2017,duration:92,rating:5.7,description:"A new series of murders appears to follow the methods of the Jigsaw Killer.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Jigsaw_2017_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Twisted Pictures",distributor:"Lionsgate Films",hollywoodEligible:true},
  {id:"61008",title:"The Dark Knight",genre:"Action, Crime, Drama",year:2008,duration:152,rating:9,description:"Batman faces a criminal mastermind who plunges Gotham into chaos.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/The_Dark_Knight_(2008_film).jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Warner Bros. Pictures;Legendary Pictures;Syncopy",distributor:"Warner Bros. Pictures",hollywoodEligible:true},
  {id:"61009",title:"Interstellar",genre:"Science Fiction, Adventure, Drama",year:2014,duration:169,rating:8.7,description:"Explorers travel through a wormhole in space in search of a new home for humanity.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Interstellar_film_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Paramount Pictures;Warner Bros. Pictures;Syncopy;Legendary Pictures",distributor:"Paramount Pictures;Warner Bros. Pictures",hollywoodEligible:true},
  {id:"61010",title:"Joker",genre:"Crime, Drama, Thriller",year:2019,duration:122,rating:8.4,description:"A troubled comedian descends into a dark transformation in Gotham City.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Joker_(2019_film)_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Warner Bros. Pictures;Village Roadshow Pictures;DC Films",distributor:"Warner Bros. Pictures",hollywoodEligible:true},
  {id:"61011",title:"Avengers: Endgame",genre:"Action, Adventure, Drama",year:2019,duration:181,rating:8.4,description:"The surviving Avengers make a final stand after a universe-changing catastrophe.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Avengers_Endgame_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Marvel Studios;Walt Disney Pictures",distributor:"Walt Disney Studios Motion Pictures",hollywoodEligible:true},
  {id:"61012",title:"Dune",genre:"Science Fiction, Adventure, Drama",year:2021,duration:155,rating:8,description:"Paul Atreides travels to the most dangerous planet in the universe.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Dune_(2021_film)_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Warner Bros. Pictures;Legendary Pictures",distributor:"Warner Bros. Pictures",hollywoodEligible:true},
  {id:"61013",title:"Oppenheimer",genre:"Biography, Drama, History",year:2023,duration:180,rating:8.6,description:"A historical drama about the scientist who led the Manhattan Project.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Oppenheimer_(film)_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Universal Pictures;Syncopy;Atlas Entertainment",distributor:"Universal Pictures",hollywoodEligible:true},
  {id:"61014",title:"Barbie",genre:"Comedy, Fantasy, Adventure",year:2023,duration:114,rating:6.8,description:"Barbie leaves her perfect world and discovers the real world.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Barbie_(2023_film)_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Warner Bros. Pictures;LuckyChap Entertainment;Heyday Films",distributor:"Warner Bros. Pictures",hollywoodEligible:true},
  {id:"61015",title:"John Wick: Chapter 4",genre:"Action, Crime, Thriller",year:2023,duration:169,rating:7.6,description:"John Wick uncovers a path to defeating the High Table.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/John_Wick_Chapter_4_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Lionsgate;Thunder Road Pictures",distributor:"Lionsgate",hollywoodEligible:true},
  {id:"61016",title:"Top Gun: Maverick",genre:"Action, Drama",year:2022,duration:131,rating:8.2,description:"Maverick trains a new generation of elite fighter pilots.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Top_Gun_Maverick_Poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Paramount Pictures;Skydance;Jerry Bruckheimer Films",distributor:"Paramount Pictures",hollywoodEligible:true},
  {id:"61017",title:"Spider-Man: No Way Home",genre:"Action, Adventure, Science Fiction",year:2021,duration:148,rating:8.2,description:"Spider-Man faces villains from across the multiverse.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Spider-Man_No_Way_Home_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Columbia Pictures;Marvel Studios;Pascal Pictures",distributor:"Sony Pictures Releasing",hollywoodEligible:true},
  {id:"61018",title:"Jurassic World",genre:"Science Fiction, Adventure, Action",year:2015,duration:124,rating:6.9,description:"A dinosaur theme park falls into chaos after a dangerous creature escapes.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Jurassic_World_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Universal Pictures;Amblin Entertainment;Legendary Pictures",distributor:"Universal Pictures",hollywoodEligible:true},
  {id:"61019",title:"Avatar: The Way of Water",genre:"Science Fiction, Adventure, Action",year:2022,duration:192,rating:7.5,description:"The Sully family returns to Pandora and seeks refuge among a new clan.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Avatar_The_Way_of_Water_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"20th Century Studios;Lightstorm Entertainment",distributor:"20th Century Studios",hollywoodEligible:true},
  {id:"61020",title:"Bullet Train",genre:"Action, Comedy, Thriller",year:2022,duration:127,rating:7.3,description:"Five assassins discover their missions are mysteriously connected aboard a high-speed train.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Bullet_Train_(film)_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Columbia Pictures;87North Productions",distributor:"Sony Pictures Releasing",hollywoodEligible:true},
  {id:"61021",title:"Godzilla vs. Kong",genre:"Action, Science Fiction",year:2021,duration:113,rating:6.3,description:"Two legendary monsters collide in an epic battle.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Godzilla_vs._Kong_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Warner Bros. Pictures;Legendary Pictures",distributor:"Warner Bros. Pictures",hollywoodEligible:true},
  {id:"61022",title:"Avengers: Infinity War",genre:"Action, Adventure, Science Fiction",year:2018,duration:149,rating:8.4,description:"The Avengers and their allies face Thanos and the threat of the Infinity Stones.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Avengers_Infinity_War_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Marvel Studios;Walt Disney Pictures",distributor:"Walt Disney Studios Motion Pictures",hollywoodEligible:true},
  {id:"61023",title:"Captain Marvel",genre:"Action, Adventure, Science Fiction",year:2019,duration:123,rating:6.8,description:"Carol Danvers becomes one of the universe's most powerful heroes.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Captain_Marvel_(film)_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Marvel Studios;Walt Disney Pictures",distributor:"Walt Disney Studios Motion Pictures",hollywoodEligible:true},
  {id:"61024",title:"Black Panther",genre:"Action, Adventure, Science Fiction",year:2018,duration:134,rating:7.3,description:"T'Challa returns to Wakanda to claim the throne and protect his nation.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Black_Panther_(film)_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Marvel Studios;Walt Disney Pictures",distributor:"Walt Disney Studios Motion Pictures",hollywoodEligible:true},
  {id:"61025",title:"Thor: Ragnarok",genre:"Action, Adventure, Comedy",year:2017,duration:130,rating:7.9,description:"Thor must escape Sakaar and stop an apocalyptic threat to Asgard.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Thor_Ragnarok_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Marvel Studios;Walt Disney Pictures",distributor:"Walt Disney Studios Motion Pictures",hollywoodEligible:true},
  {id:"61026",title:"The Lord of the Rings: The Fellowship of the Ring",genre:"Fantasy, Adventure, Drama",year:2001,duration:178,rating:8.9,description:"A hobbit begins a journey to destroy a powerful ring and save Middle-earth.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/The_Lord_of_the_Rings_The_Fellowship_of_the_Ring_(2001).jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"New Line Cinema;WingNut Films",distributor:"New Line Cinema",hollywoodEligible:true},
  {id:"61027",title:"Doctor Strange in the Multiverse of Madness",genre:"Action, Adventure, Fantasy",year:2022,duration:126,rating:6.9,description:"Doctor Strange travels through alternate realities in a dangerous multiverse adventure.",posterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Doctor_Strange_in_the_Multiverse_of_Madness_poster.jpg?width=600",published:true,originalLanguage:"en",countries:"United States",productionCompanies:"Marvel Studios;Walt Disney Pictures",distributor:"Walt Disney Studios Motion Pictures",hollywoodEligible:true}
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
