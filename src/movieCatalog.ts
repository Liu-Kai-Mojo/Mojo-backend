import { prisma } from "./prisma.js";

export type EligibleMovie = {
  id:string; title:string; genre:string; year:number; duration:number; rating:number;
  description:string; posterUrl:string; published:boolean; originalLanguage:string;
  countries:string; productionCompanies:string; distributor:string; hollywoodEligible:boolean;
};

const english=/^(en|english)$/i;
const hollywoodCompany=/(warner|universal|paramount|sony|columbia|lionsgate|20th century|fox|metro-goldwyn-mayer|mgm|legendary|blumhouse|monkeypaw|syncopy|dreamworks|disney|pixar|new line|a24|focus features|miramax|tri[- ]star|republic pictures|rko)/i;

export function isEligibleHollywoodMovie(movie:Partial<EligibleMovie>|null|undefined):movie is EligibleMovie{
  if(!movie||movie.published!==true||movie.hollywoodEligible!==true)return false;
  if(!english.test(String(movie.originalLanguage||"")))return false;
  const countries=String(movie.countries||"").toLowerCase();
  if(!/(united states|united kingdom|usa|uk)/i.test(countries))return false;
  const businessEvidence=[movie.productionCompanies,movie.distributor].map(String).join(" ");
  if(!hollywoodCompany.test(businessEvidence))return false;
  if(!String(movie.posterUrl||"").trim()||!String(movie.title||"").trim())return false;
  return true;
}

export async function getEligibleHollywoodMovies(excludeIds:string[]=[]){
  const rows=await prisma.movie.findMany({where:{published:true,hollywoodEligible:true,originalLanguage:"en"},orderBy:[{year:"desc"},{title:"asc"}]});
  return rows.filter(isEligibleHollywoodMovie).filter(m=>!excludeIds.includes(m.id));
}

export function moviePosterIsUsable(movie:EligibleMovie){return /^https?:\/\//i.test(String(movie.posterUrl||""));}
