import { prisma } from "./prisma.js";
import { uniqueSettingId } from "./utils/codes.js";
import { getEligibleHollywoodMovies, isEligibleHollywoodMovie, moviePosterIsUsable, type EligibleMovie } from "./movieCatalog.js";

export type TrendingVideo = {
  provider:"youtube"|"direct";
  videoId:string;
  title:string;
  description:string;
  channelId:string;
  channelTitle:string;
  thumbnailUrl:string;
  durationSeconds:number;
  publishedAt:string;
  categoryId:string;
  viewCount:number;
  likeCount:number;
  commentCount:number;
  liveBroadcastContent:string;
  score?:number;
  movieId:string; movieTitle:string; moviePosterUrl:string; movieReleaseDate:string|null; movieYear:number; movieGenre:string; movieOriginalLanguage:string; movieCountries:string; movieProductionCompanies:string; movieDistributor:string;
};

type TrendingConfig = {
  enabled:boolean;
  regionCode:string;
  relevanceLanguage:string;
  cacheTtlMs:number;
  poolSize:number;
  recentHistorySize:number;
  repeatCooldownHours:number;
  minDurationSeconds:number;
  maxDurationSeconds:number;
  freshnessDays:number;
  maxCandidates:number;
  refreshIntervalMs:number;
  discoveryCooldownMs:number;
  discoveryMaxAttempts:number;
};

type UpstreamError = Error & { code:string };
const cacheKey="trending_movie_trailer_cache";
const refreshState=new Map<string,Promise<TrendingVideo[]>>();
let queryCursor=0;

function providerError(code:string,message:string):UpstreamError {
  const error=new Error(message) as UpstreamError;
  error.code=code;
  return error;
}
function numberSetting(value:string|undefined,fallback:number,min=0){
  const n=Number(value);
  return Number.isFinite(n)&&n>=min?n:fallback;
}
async function readSetting(key:string){const row=await prisma.setting.findUnique({where:{key}});return row?.value;}
async function config():Promise<TrendingConfig>{
  const keys=["trending_videos_enabled","trending_region_code","trending_relevance_language","trending_cache_ttl_minutes","trending_pool_size","trending_recent_history_size","trending_repeat_cooldown_hours","trending_min_duration_seconds","trending_max_duration_seconds","trending_freshness_days","trending_max_candidates","trending_refresh_interval_minutes","trending_discovery_cooldown_minutes","trending_discovery_max_attempts"];
  const values=await Promise.all(keys.map(readSetting));
  const env=process.env;
  const discoveryMaxAttempts=Math.max(1,Math.min(4,Math.floor(numberSetting(values[13]??env.TRENDING_DISCOVERY_MAX_ATTEMPTS,4,1))));
  return {
    enabled:(values[0]??env.TRENDING_VIDEOS_ENABLED??"true").toLowerCase()!=="false",
    regionCode:"GLOBAL",
    relevanceLanguage:(values[2]??env.YOUTUBE_RELEVANCE_LANGUAGE??"en").trim(),
    cacheTtlMs:numberSetting(values[3]??env.TRAILER_CACHE_TTL??env.TRENDING_CACHE_TTL_MINUTES,60)*60_000,
    poolSize:Math.max(10,Math.min(50,Math.floor(numberSetting(values[4]??env.TRENDING_POOL_SIZE,30,1)))),
    recentHistorySize:Math.max(1,Math.min(50,Math.floor(numberSetting(values[5]??env.TRENDING_RECENT_HISTORY_SIZE,10,1)))),
    repeatCooldownHours:numberSetting(values[6]??env.TRAILER_REPEAT_COOLDOWN_HOURS,24),
    minDurationSeconds:Math.floor(numberSetting(values[7]??env.TRAILER_MIN_DURATION_SECONDS??env.TRENDING_MIN_DURATION_SECONDS,30)),
    maxDurationSeconds:Math.floor(numberSetting(values[8]??env.TRAILER_MAX_DURATION_SECONDS??env.TRENDING_MAX_DURATION_SECONDS,600)),
    freshnessDays:Math.max(1,Math.min(3650,Math.floor(numberSetting(values[9]??env.TRAILER_FRESHNESS_DAYS??env.TRENDING_FRESHNESS_DAYS,30,1)))),
    maxCandidates:Math.max(10,Math.min(50,Math.floor(numberSetting(values[10]??env.TRAILER_MAX_CANDIDATES,50,1)))),
    refreshIntervalMs:Math.max(5,numberSetting(values[11]??env.TRAILER_REFRESH_INTERVAL_MINUTES,60,5))*60_000,
    discoveryCooldownMs:Math.max(5,numberSetting(values[12]??env.TRENDING_DISCOVERY_COOLDOWN_MINUTES,360,5))*60_000,
    discoveryMaxAttempts
  };
}
function parseDuration(value:string){
  const m=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value||"");
  return m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0;
}
function clean(value:string){return value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();}
export function normalizeMovieTitle(value:string){const raw=clean(value).replace(/\s+/g," ");if(!raw)return "Movie";return raw.replace(/\s*[|–—:-]\s*(?:the\s+)?(?:new\s+|latest\s+|official\s+|exclusive\s+|final\s+|movie\s+)*(?:official\s+)?(?:trailer|teaser)(?:\s*(?:#|part|pt\.?|\d+).*)?$/i,"").replace(/\s*\((?:the\s+)?(?:new\s+|latest\s+|official\s+|exclusive\s+|final\s+)?(?:trailer|teaser)(?:\s*(?:#|part|pt\.?|\d+).*)?\)$/i,"").replace(/\s+\b(?:official|new|latest|exclusive|final)\s+(?:trailer|teaser)\b.*$/i,"").replace(/\s*[-–—|]+\s*$/,"").trim()||raw;}
const OPEN_LICENSED_VIDEO_FALLBACKS:TrendingVideo[]=[
  {provider:"direct",videoId:"https://video.blender.org/static/webseed/bf1f3fb5-b119-4f9f-9930-8e20e892b898-720.mp4",title:"Big Buck Bunny — Open Movie",description:"Blender Foundation open movie. Creative Commons Attribution 3.0; attribution required: Blender Foundation / bigbuckbunny.org.",channelId:"blender-open-movie",channelTitle:"Blender Foundation · Open Movies",thumbnailUrl:"https://commons.wikimedia.org/wiki/Special:Redirect/file/Big_Buck_Bunny.jpg",durationSeconds:596,publishedAt:"2008-03-01T00:00:00.000Z",categoryId:"1",viewCount:0,likeCount:0,commentCount:0,liveBroadcastContent:"none",score:80,movieId:"open-bbb",movieTitle:"Big Buck Bunny",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:Redirect/file/Big_Buck_Bunny.jpg",movieReleaseDate:"2008-03-01T00:00:00.000Z",movieYear:2008,movieGenre:"Animation, Adventure",movieOriginalLanguage:"en",movieCountries:"Netherlands",movieProductionCompanies:"Blender Foundation",movieDistributor:"Blender Foundation"},
  {provider:"direct",videoId:"https://video.blender.org/static/webseed/0eb052d0-fd51-43e6-aa33-ecdbf77a5d40-720.mp4",title:"Sintel — Open Movie",description:"Blender Foundation open movie. Creative Commons Attribution 3.0; attribution required: Blender Foundation / durian.blender.org.",channelId:"blender-open-movie",channelTitle:"Blender Foundation · Open Movies",thumbnailUrl:"https://commons.wikimedia.org/wiki/Special:Redirect/file/Sintel.jpg",durationSeconds:888,publishedAt:"2010-05-13T00:00:00.000Z",categoryId:"1",viewCount:0,likeCount:0,commentCount:0,liveBroadcastContent:"none",score:79,movieId:"open-sintel",movieTitle:"Sintel",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:Redirect/file/Sintel.jpg",movieReleaseDate:"2010-05-13T00:00:00.000Z",movieYear:2010,movieGenre:"Fantasy, Adventure",movieOriginalLanguage:"en",movieCountries:"Netherlands",movieProductionCompanies:"Blender Foundation",movieDistributor:"Blender Foundation"},
  {provider:"direct",videoId:"https://video.blender.org/static/webseed/8533ea43-4271-4a57-9694-e9d0b35e1aa1-720.mp4",title:"Tears of Steel — Open Movie",description:"Blender Foundation open movie. Creative Commons Attribution 3.0; attribution required: Blender Foundation / mango.blender.org.",channelId:"blender-open-movie",channelTitle:"Blender Foundation · Open Movies",thumbnailUrl:"https://commons.wikimedia.org/wiki/Special:Redirect/file/Tears_of_Steel_frame_05_6a.jpg",durationSeconds:734,publishedAt:"2012-09-26T00:00:00.000Z",categoryId:"1",viewCount:0,likeCount:0,commentCount:0,liveBroadcastContent:"none",score:78,movieId:"open-tos",movieTitle:"Tears of Steel",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:Redirect/file/Tears_of_Steel_frame_05_6a.jpg",movieReleaseDate:"2012-09-26T00:00:00.000Z",movieYear:2012,movieGenre:"Science Fiction, Action",movieOriginalLanguage:"en",movieCountries:"Netherlands",movieProductionCompanies:"Blender Foundation",movieDistributor:"Blender Foundation"}
];
function openLicensedFallback(clientId:string,count:number){
  const shuffled=[...OPEN_LICENSED_VIDEO_FALLBACKS].sort(()=>Math.random()-0.5);
  const recent=new Set<string>();
  return Array.from({length:Math.max(1,count)},(_,i)=>shuffled[i%shuffled.length]).filter((v,i)=>i<Math.max(1,count));
}

const DEFAULT_INDIA_TITLE_EXCLUSIONS="";
const DEFAULT_INDIA_CHANNEL_EXCLUSIONS="";

const INDIA_TITLE_EXCLUSIONS=new RegExp(process.env.TRAILER_INDIA_TITLE_EXCLUSIONS||DEFAULT_INDIA_TITLE_EXCLUSIONS,"i");
const INDIA_CHANNEL_EXCLUSIONS=new RegExp(process.env.TRAILER_INDIA_CHANNEL_EXCLUSIONS||DEFAULT_INDIA_CHANNEL_EXCLUSIONS,"i");
function isLikelyTrailer(title:string,description:string,channelTitle=""){
  const titleText=String(title||"").toLowerCase();
  const channelText=String(channelTitle||"").toLowerCase();
  const negativeTitle=/\\b(reaction|reacts|review|recap|explained|breakdown|fan\\s*(made|trailer|edit)|parody|spoof|edit|shorts?|interview|behind\\s+the\\s+scenes|podcast|news|gameplay|song|lyric|ost)\\b/i.test(titleText);
  const negativeChannel=/\\b(reaction|review|recap|explained|breakdown|parody|spoof|shorts?|podcast|news|gameplay|music)\\b/i.test(channelText);
  // Do not require words such as "official trailer", "trailer", or a
  // Hollywood studio name. Valid movie trailers are identified by the
  // discovery query and then by backend video validation, not exact title
  // wording or geography.
  if(INDIA_TITLE_EXCLUSIONS.test(String(title)+" "+String(description))||INDIA_CHANNEL_EXCLUSIONS.test(String(channelTitle)))return false;
  return !negativeTitle&&!negativeChannel;
}
function scoreVideo(v:TrendingVideo,cfg:TrendingConfig){
  const text=(v.title+" "+v.description+" "+v.channelTitle).toLowerCase();
  const ageDays=Math.max(0,(Date.now()-Date.parse(v.publishedAt))/86400000);
  const freshness=Number.isFinite(ageDays)?Math.max(0,30-Math.min(30,(ageDays/cfg.freshnessDays)*30)):0;
  const views=Math.min(30,Math.log10(Math.max(1,v.viewCount))*4);
  const velocity=Math.min(25,v.viewCount/Math.max(1,ageDays)/10000);
  const keyword=/official\s+trailer/.test(text)?40:/official\s+teaser/.test(text)?34:/\b(trailer|teaser|clip|featurette)\b/.test(text)?24:0;
  const channel=/\bofficial\b|pictures|films?|studios?|entertainment|distribution|movies?/i.test(v.channelTitle)?10:0;
  const engagement=Math.min(10,Math.log10(Math.max(1,v.likeCount+v.commentCount))*2);
  return keyword+freshness+views+velocity+channel+engagement;
}
function rank(pool:TrendingVideo[],cfg:TrendingConfig){
  const map=new Map<string,TrendingVideo>();
  for(const v of pool){
    if(!v.videoId||map.has(v.videoId)||!v.movieId||!v.moviePosterUrl)continue;
    if(v.durationSeconds<cfg.minDurationSeconds)continue;
    if(cfg.maxDurationSeconds>0&&v.durationSeconds>cfg.maxDurationSeconds)continue;
    if(!v.thumbnailUrl||!v.publishedAt)continue;
    map.set(v.videoId,{...v,score:scoreVideo(v,cfg)});
  }
  return [...map.values()].sort((a,b)=>(b.score??0)-(a.score??0)).slice(0,cfg.poolSize);
}
function movieTerms(title:string){return normalizeMovieTitle(title).toLowerCase().replace(/[^a-z0-9]+/g," ").trim().split(/\s+/).filter(x=>x.length>1);}
function isMovieAssociated(rawTitle:string,description:string,movie:EligibleMovie){
  const hay=(String(rawTitle)+" "+String(description)).toLowerCase().replace(/[^a-z0-9]+/g," ");
  const canonical=movie.title.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  const terms=movieTerms(movie.title);
  return hay.includes(canonical)||terms.filter(term=>hay.includes(term)).length>=Math.max(1,Math.ceil(terms.length*.6));
}
function contentRejection(rawTitle:string,description:string,channelTitle:string,categoryId:string,movie:EligibleMovie){
  const title=String(rawTitle||"").toLowerCase(),channel=String(channelTitle||"").toLowerCase();
  if(["10","20","25","15","17"].includes(String(categoryId||"")))return "UNSUPPORTED_CONTENT";
  if(/\b(music video|official audio|lyrics?|soundtrack|song|ost)\b/i.test(title))return "MUSIC_VIDEO";
  if(/\b(gameplay|gaming|walkthrough|stream)\b/i.test(title+" "+channel))return "GAMING_VIDEO";
  if(/\b(reaction|reacts|review|recap|explained|breakdown|parody|spoof|fan\s*(made|trailer|edit)|compilation|news|interview|podcast)\b/i.test(title))return "NOT_MOVIE_CONTENT";
  if(!/\b(shorts?|clip|scene|trailer|teaser|featurette)\b/i.test(title))return "NOT_MOVIE_CONTENT";
  if(!isMovieAssociated(rawTitle,description,movie))return "NO_MOVIE_ASSOCIATION";
  return "";
}
async function youtubeRequest(url:URL,operation:string){
  let response:Response;
  try{response=await fetch(url,{signal:AbortSignal.timeout(9000)});}
  catch(error){throw providerError("YOUTUBE_API_ERROR",error instanceof Error&&error.name==="TimeoutError"?operation+" timed out.":operation+" could not be reached.");}
  if(!response.ok){
    let detail="";let message="";let reasons:string[]=[];
    try{const body:any=await response.json();detail=String(body?.error?.errors?.[0]?.reason||body?.error?.status||"");message=String(body?.error?.message||"");reasons=Array.isArray(body?.error?.errors)?body.error.errors.map((e:any)=>String(e?.reason||"")).filter(Boolean).slice(0,5):[];}catch{}
    console.error("[youtube] upstream error",{operation,status:response.status,statusText:response.statusText,reason:detail,message,reasons});
    if(response.status===401)return providerError("YOUTUBE_AUTH_ERROR","YouTube authentication failed.");
    if(response.status===403&&/quota/i.test(detail))return providerError("YOUTUBE_QUOTA_EXHAUSTED","YouTube quota has been exhausted.");
    if(response.status===429)return providerError("YOUTUBE_QUOTA_EXHAUSTED","YouTube rate limit/quota was reached.");
    return providerError("YOUTUBE_API_ERROR","YouTube rejected or failed the request.");
  }
  return response.json() as Promise<any>;
}
async function discover(movie:EligibleMovie,cfg:TrendingConfig){
  const key=String(process.env.YOUTUBE_API_KEY||"").trim();
  if(!key)throw providerError("YOUTUBE_AUTH_ERROR","YOUTUBE_API_KEY is not configured on the backend.");
  if(!isEligibleHollywoodMovie(movie)||!moviePosterIsUsable(movie))throw providerError("NO_ELIGIBLE_HOLLYWOOD_MOVIE","The selected movie is not eligible for MOJO.");
  const queries=[movie.title+" official trailer",movie.title+" official teaser",movie.title+" official featurette",movie.title+" official clip",movie.title+" movie scene",movie.title+" trailer",movie.title+" movie clip"];
  const searchResults:any[]=[];let ids:string[]=[];let lastQuery="";
  for(const query of queries.slice(0,cfg.discoveryMaxAttempts)){
    const url=new URL("https://youtube.googleapis.com/youtube/v3/search");
    url.searchParams.set("part","snippet");url.searchParams.set("type","video");url.searchParams.set("order","relevance");url.searchParams.set("relevanceLanguage","en");url.searchParams.set("maxResults","10");url.searchParams.set("q",query);url.searchParams.set("key",key);
    console.log("[trending] YouTube search request",{operation:"search.list",part:"snippet",q:query,type:"video",maxResults:10,regionCode:null,relevanceLanguage:"en",safeSearch:null,order:"relevance"});
    const result=await youtubeRequest(url,"YouTube movie-specific search");searchResults.push(result);lastQuery=query;
    const current=Array.isArray(result?.items)?result.items:[];ids=[...new Set(searchResults.flatMap((s:any)=>Array.isArray(s?.items)?s.items.map((x:any)=>String(x?.id?.videoId||"")).filter(Boolean):[]))].slice(0,50);
    console.log("[trending] YouTube discovery",{query,region:"GLOBAL",resultCount:current.length,candidateCount:ids.length});
    if(current.length)break;
  }
  if(!ids.length)throw providerError("YOUTUBE_ZERO_RESULTS","YouTube returned zero results for the selected Hollywood movie.");
  const detailUrl=new URL("https://youtube.googleapis.com/youtube/v3/videos");detailUrl.searchParams.set("part","snippet,contentDetails,status,statistics");detailUrl.searchParams.set("id",ids.join(","));detailUrl.searchParams.set("key",key);
  const details:any=await youtubeRequest(detailUrl,"YouTube movie video validation");
  const candidates:TrendingVideo[]=[];const rejected:Record<string,number>={};const reject=(reason:string)=>{rejected[reason]=(rejected[reason]||0)+1;};
  for(const item of Array.isArray(details.items)?details.items:[]){
    const snippet=item.snippet||{},status=item.status||{},stats=item.statistics||{};const rawTitle=String(snippet.title||"").trim(),description=String(snippet.description||"");const channelTitle=String(snippet.channelTitle||"").trim(),videoId=String(item.id||"").trim();
    if(!videoId){reject("INVALID_VIDEO_ID");continue;}if(String(status.privacyStatus)!=="public"||status.embeddable!==true){reject("NOT_PLAYABLE");continue;}
    const published=String(snippet.publishedAt||"");if(!published){reject("UNSUPPORTED_CONTENT");continue;}
    const reason=contentRejection(rawTitle,description,channelTitle,String(snippet.categoryId||""),movie);if(reason){reject(reason);continue;}
    const duration=parseDuration(String(item.contentDetails?.duration||""));if(duration<cfg.minDurationSeconds||cfg.maxDurationSeconds>0&&duration>cfg.maxDurationSeconds){reject("UNSUPPORTED_CONTENT");continue;}
    const thumb=String(snippet.thumbnails?.maxres?.url||snippet.thumbnails?.high?.url||snippet.thumbnails?.standard?.url||snippet.thumbnails?.medium?.url||snippet.thumbnails?.default?.url||"");if(!thumb){reject("NO_THUMBNAIL");continue;}
    candidates.push({provider:"youtube",videoId,title:rawTitle,description,channelId:String(snippet.channelId||""),channelTitle,publishedAt:published,thumbnailUrl:thumb,durationSeconds:duration,categoryId:String(snippet.categoryId||""),viewCount:Number(stats.viewCount||0),likeCount:Number(stats.likeCount||0),commentCount:Number(stats.commentCount||0),liveBroadcastContent:String(snippet.liveBroadcastContent||"none"),movieId:movie.id,movieTitle:movie.title,moviePosterUrl:movie.posterUrl,movieReleaseDate:new Date(movie.year+"-01-01T00:00:00.000Z").toISOString(),movieYear:movie.year,movieGenre:movie.genre,movieOriginalLanguage:movie.originalLanguage,movieCountries:movie.countries,movieProductionCompanies:movie.productionCompanies,movieDistributor:movie.distributor});
  }
  console.log("[trending] YouTube post-search filtering",{query:lastQuery,region:"GLOBAL",returnedFromVideosList:Array.isArray(details.items)?details.items.length:0,candidateCount:ids.length,acceptedCount:candidates.length,rejected});
  const finalPool=rank(candidates,cfg);if(!finalPool.length)throw providerError("YOUTUBE_CANDIDATES_REJECTED","YouTube returned candidates but none passed Hollywood movie validation.");return finalPool;
}
async function writeCache(pool:TrendingVideo[]){
  const now=new Date();
  for(const v of pool)await prisma.trailerCache.upsert({where:{videoId:v.videoId},create:{id:await uniqueSettingId(),videoId:v.videoId,title:v.title,description:v.description,channelId:v.channelId,channelTitle:v.channelTitle,publishedAt:new Date(v.publishedAt),thumbnailUrl:v.thumbnailUrl,durationSeconds:v.durationSeconds,categoryId:v.categoryId,viewCount:v.viewCount,likeCount:v.likeCount,commentCount:v.commentCount,embeddable:true,privacyStatus:"public",score:v.score??0,lastValidatedAt:now,lastSeenAt:now,createdAt:now,updatedAt:now,movieId:v.movieId,movieTitle:v.movieTitle,moviePosterUrl:v.moviePosterUrl,movieReleaseDate:v.movieReleaseDate?new Date(v.movieReleaseDate):null,movieYear:v.movieYear,movieGenre:v.movieGenre,movieOriginalLanguage:v.movieOriginalLanguage,movieCountries:v.movieCountries,movieProductionCompanies:v.movieProductionCompanies,movieDistributor:v.movieDistributor,movieHollywoodEligible:true},update:{title:v.title,description:v.description,channelId:v.channelId,channelTitle:v.channelTitle,publishedAt:new Date(v.publishedAt),thumbnailUrl:v.thumbnailUrl,durationSeconds:v.durationSeconds,categoryId:v.categoryId,viewCount:v.viewCount,likeCount:v.likeCount,commentCount:v.commentCount,embeddable:true,privacyStatus:"public",score:v.score??0,lastValidatedAt:now,lastSeenAt:now,movieId:v.movieId,movieTitle:v.movieTitle,moviePosterUrl:v.moviePosterUrl,movieReleaseDate:v.movieReleaseDate?new Date(v.movieReleaseDate):null,movieYear:v.movieYear,movieGenre:v.movieGenre,movieOriginalLanguage:v.movieOriginalLanguage,movieCountries:v.movieCountries,movieProductionCompanies:v.movieProductionCompanies,movieDistributor:v.movieDistributor,movieHollywoodEligible:true}});
}
function fromCache(row:any):TrendingVideo{return {provider:"youtube",videoId:row.videoId,title:row.title,description:row.description,channelId:row.channelId,channelTitle:row.channelTitle,thumbnailUrl:row.thumbnailUrl,durationSeconds:row.durationSeconds,publishedAt:row.publishedAt.toISOString(),categoryId:row.categoryId,viewCount:row.viewCount,likeCount:row.likeCount,commentCount:row.commentCount,liveBroadcastContent:"none",score:row.score,movieId:String(row.movieId),movieTitle:String(row.movieTitle),moviePosterUrl:String(row.moviePosterUrl),movieReleaseDate:row.movieReleaseDate?row.movieReleaseDate.toISOString():null,movieYear:Number(row.movieYear||0),movieGenre:String(row.movieGenre||""),movieOriginalLanguage:String(row.movieOriginalLanguage||""),movieCountries:String(row.movieCountries||""),movieProductionCompanies:String(row.movieProductionCompanies||""),movieDistributor:String(row.movieDistributor||"")};}
async function fetchExternalOk(url:string,method:"GET"|"HEAD"="GET"){
  try{
    const response=await fetch(url,{method,signal:AbortSignal.timeout(7000),headers:method==="GET"?{Range:"bytes=0-1"}:undefined});
    return response.ok;
  }catch{return false;}
}
function imageDimensions(bytes:Uint8Array,contentType:string){
  const type=String(contentType||"").toLowerCase();
  if(type.includes("png")&&bytes.length>=24&&bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71){
    return {width:new DataView(bytes.buffer,bytes.byteOffset).getUint32(16),height:new DataView(bytes.buffer,bytes.byteOffset).getUint32(20)};
  }
  if(type.includes("jpeg")&&bytes.length>4&&bytes[0]===0xff&&bytes[1]===0xd8){
    let i=2;
    while(i+9<bytes.length){
      if(bytes[i]!==0xff){i++;continue;}
      const marker=bytes[i+1];i+=2;
      if(marker===0xd8||marker===0xd9)continue;
      if(i+2>bytes.length)break;
      const len=(bytes[i]<<8)|bytes[i+1];
      if(len<2||i+len>bytes.length)break;
      if((marker>=0xc0&&marker<=0xc3)||(marker>=0xc5&&marker<=0xc7)||(marker>=0xc9&&marker<=0xcb)||(marker>=0xcd&&marker<=0xcf)){
        return {height:(bytes[i+3]<<8)|bytes[i+4],width:(bytes[i+5]<<8)|bytes[i+6]};
      }
      i+=len;
    }
  }
  if(type.includes("webp")&&bytes.length>=30&&String.fromCharCode(...bytes.slice(0,4))==="RIFF"&&String.fromCharCode(...bytes.slice(8,12))==="WEBP"){
    const four=String.fromCharCode(...bytes.slice(12,16));
    if(four==="VP8X")return {width:1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),height:1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)};
  }
  return null;
}
async function validatePosterUrl(url:string){
  const candidate=String(url||"").trim();
  if(!/^https?:\/\//i.test(candidate))return {valid:false,reason:"INVALID_URL"};
  try{
    const response=await fetch(candidate,{signal:AbortSignal.timeout(7000),headers:{Accept:"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"}});
    if(!response.ok)return {valid:false,reason:"HTTP_"+response.status};
    const type=String(response.headers.get("content-type")||"").toLowerCase();
    if(!type.startsWith("image/"))return {valid:false,reason:"NOT_IMAGE"};
    const bytes=new Uint8Array(await response.arrayBuffer());
    const dimensions=imageDimensions(bytes,type);
    if(!dimensions||dimensions.width<200||dimensions.height<300)return {valid:false,reason:"INVALID_DIMENSIONS"};
    if(dimensions.height<dimensions.width*1.25)return {valid:false,reason:"NOT_PORTRAIT"};
    return {valid:true,width:dimensions.width,height:dimensions.height};
  }catch{return {valid:false,reason:"FETCH_FAILED"};}
}
async function resolveTmdbPoster(movie:EligibleMovie){
  const token=String(process.env.TMDB_API_READ_TOKEN||"").trim();
  if(!token)return null;
  try{
    const url=new URL("https://api.themoviedb.org/3/search/movie");
    url.searchParams.set("query",movie.title);
    url.searchParams.set("include_adult","false");
    url.searchParams.set("language","en-US");
    url.searchParams.set("page","1");
    if(movie.year>0)url.searchParams.set("primary_release_year",String(movie.year));
    const response=await fetch(url,{signal:AbortSignal.timeout(7000),headers:{Accept:"application/json",Authorization:"Bearer "+token}});
    if(!response.ok)return null;
    const payload:any=await response.json();
    const results=Array.isArray(payload?.results)?payload.results:[];
    const normalized=movie.title.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
    const match=results.find((item:any)=>{
      const title=String(item?.title||item?.original_title||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
      const year=Number(String(item?.release_date||"").slice(0,4));
      return title===normalized&&(!movie.year||!year||year===movie.year)&&String(item?.poster_path||"").trim();
    })||results.find((item:any)=>String(item?.poster_path||"").trim());
    if(!match?.poster_path)return null;
    const poster="https://image.tmdb.org/t/p/w780"+String(match.poster_path);
    const validation=await validatePosterUrl(poster);
    if(!validation.valid)return null;
    console.log("[poster-validation]",{operation:"tmdb-resolve",movieId:movie.id,movieTitle:movie.title,status:"valid",width:validation.width,height:validation.height});
    return poster;
  }catch{return null;}
}
async function ensureMoviePoster(movie:EligibleMovie,existing:string){
  const current=String(existing||"").trim();
  const currentValidation=await validatePosterUrl(current);
  if(currentValidation.valid)return current;
  const repaired=await resolveTmdbPoster(movie);
  if(repaired){
    await prisma.movie.update({where:{id:movie.id},data:{posterUrl:repaired}}).catch(()=>{});
    return repaired;
  }
  return null;
}
async function validateCachedVideo(row:any){
  const videoId=String(row.videoId||"").trim();
  const thumbnail=String(row.thumbnailUrl||"").trim();
  const movieId=String(row.movieId||"").trim();
  const movie=movieId?await prisma.movie.findUnique({where:{id:movieId}}):null;
  if(!videoId||!thumbnail||!movie||!isEligibleHollywoodMovie(movie))return {valid:false,reason:"MISSING_REQUIRED_METADATA"};
  const [oembedOk,thumbnailOk]=await Promise.all([
    fetchExternalOk("https://www.youtube.com/oembed?url="+encodeURIComponent("https://www.youtube.com/watch?v="+videoId)+"&format=json"),
    fetchExternalOk(thumbnail)
  ]);
  if(!oembedOk)return {valid:false,reason:"VIDEO_UNAVAILABLE"};
  if(!thumbnailOk)return {valid:false,reason:"THUMBNAIL_UNAVAILABLE"};
  // A temporarily unreachable poster host must not invalidate an otherwise
  // playable, public, embeddable video. Fall back to its verified video
  // thumbnail so the task can still start and the card never stays blank.
  const poster=await ensureMoviePoster(movie,String(row.moviePosterUrl||""))||thumbnail;
  if(poster!==String(row.moviePosterUrl||""))await prisma.trailerCache.update({where:{videoId},data:{moviePosterUrl:poster}});
  return {valid:true,reason:poster===thumbnail?"OK_WITH_VIDEO_THUMBNAIL":"OK",posterUrl:poster};
}
const CACHE_REVALIDATION_MS=15*60_000;
async function loadCache(cfg:TrendingConfig,allowStale=false){
  const cutoff=new Date(Date.now()-cfg.freshnessDays*86400000);
  const rows=await prisma.trailerCache.findMany({where:{embeddable:true,privacyStatus:"public",movieHollywoodEligible:true,movieId:{not:null},movieTitle:{not:null},moviePosterUrl:{not:null},...(allowStale?{}:{lastValidatedAt:{gte:cutoff}})},orderBy:{score:"desc"},take:Math.max(cfg.poolSize,50)});
  const now=Date.now();
  const candidates=rows.slice(0,cfg.poolSize);
  const checked=await Promise.all(candidates.map(async row=>{
    const videoId=String(row.videoId||"").trim();
    // Bootstrap-verified videos are deliberately usable during upstream
    // validation outages. They are still restricted to the curated set below
    // and must carry the complete public/embeddable metadata stored in cache.
    if(VERIFIED_HOLLYWOOD_VIDEOS.some(v=>v.videoId===videoId)
      && row.embeddable===true
      && row.privacyStatus==="public"
      && row.movieHollywoodEligible===true
      && String(row.thumbnailUrl||"").trim()
      && String(row.moviePosterUrl||"").trim()){
      return fromCache(row);
    }
    const lastValidated=row.lastValidatedAt?new Date(row.lastValidatedAt).getTime():0;
    if(lastValidated>0 && now-lastValidated<CACHE_REVALIDATION_MS)return fromCache(row);
    const validation=await validateCachedVideo(row);
    if(validation.valid){
      await prisma.trailerCache.update({where:{videoId:row.videoId},data:{lastValidatedAt:new Date(),lastSeenAt:new Date(),...(validation.posterUrl?{moviePosterUrl:validation.posterUrl}:{})}});
      return fromCache({...row,moviePosterUrl:validation.posterUrl||row.moviePosterUrl});
    }
    console.warn("[trending] stale cache rejected",{operation:"cache-validation",videoId:String(row.videoId),movieId:String(row.movieId||""),movieTitle:String(row.movieTitle||""),reason:validation.reason});
    await prisma.trailerCache.update({where:{videoId:row.videoId},data:{lastValidatedAt:new Date(0),lastSeenAt:new Date()}}).catch(()=>{});
    return null;
  }));
  const valid=checked.filter((value):value is TrendingVideo=>Boolean(value));
  return valid;
}
async function recentVideoIds(clientId:string,cfg:TrendingConfig){
  const cutoff=new Date(Date.now()-cfg.repeatCooldownHours*3600000);
  const recent=await prisma.task.findMany({where:{clientId,videoId:{not:null},revealedAt:{gte:cutoff}},select:{videoId:true},orderBy:{revealedAt:"desc"},take:cfg.recentHistorySize});
  return new Set(recent.map(x=>String(x.videoId)));
}
async function selectMany(clientId:string,pool:TrendingVideo[],count:number,cfg:TrendingConfig){
  if(!pool.length)throw providerError("TRAILER_CACHE_EMPTY","No validated YouTube trailer is currently cached.");
  const recentIds=await recentVideoIds(clientId,cfg);
  const preferred=pool.filter(v=>!recentIds.has(v.videoId));
  const source=preferred.length>=count?preferred:[...preferred,...pool.filter(v=>!preferred.some(p=>p.videoId===v.videoId))];
  const shuffled=[...source].sort(()=>Math.random()-0.5);
  const selected:TrendingVideo[]=[];
  const used=new Set<string>();
  for(const v of shuffled){if(used.has(v.videoId))continue;selected.push(v);used.add(v.videoId);if(selected.length>=count)break;}
  if(selected.length<count){
    for(const v of pool){if(used.has(v.videoId))continue;selected.push(v);used.add(v.videoId);if(selected.length>=count)break;}
  }
  // If the catalog is smaller than the requested task count, reuse cached
  // videos only after every eligible unique video has been used once.
  // This avoids quota hammering while still allowing the TaskSession to be
  // generated normally when the cache is temporarily small.
  if(selected.length<count){
    let index=0;
    while(selected.length<count&&pool.length){selected.push(pool[index%pool.length]);index++;}
  }
  return selected;
}
async function select(clientId:string,pool:TrendingVideo[],cfg:TrendingConfig){return (await selectMany(clientId,pool,1,cfg))[0];}
const INVALID_KNOWN_VIDEO_IDS=new Set(["vPP6alw1vgY"]);
const VERIFIED_HOLLYWOOD_CACHE_KEY="hollywood_verified_cache_v1";
const VERIFIED_HOLLYWOOD_VIDEOS=[
  {id:"62001",videoId:"Qwe6qXFTdgc",title:"Inception | Official Trailer",channelTitle:"Warner Bros. Entertainment",publishedAt:"2010-10-19T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/Qwe6qXFTdgc/hqdefault.jpg",durationSeconds:180,movieId:"61004",movieTitle:"Inception",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Inception_(2010)_theatrical_poster.jpg?width=600",movieReleaseDate:"2010-07-16T00:00:00.000Z",movieYear:2010,movieGenre:"Science Fiction, Action, Thriller",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Warner Bros. Pictures;Legendary Pictures;Syncopy",movieDistributor:"Warner Bros. Pictures",score:100},
  {id:"62002",videoId:"sRfnevzM9kQ",title:"Get Out | Official Trailer",channelTitle:"Universal Pictures",publishedAt:"2016-10-04T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/sRfnevzM9kQ/hqdefault.jpg",durationSeconds:153,movieId:"61005",movieTitle:"Get Out",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Get_Out_poster.png?width=600",movieReleaseDate:"2017-02-24T00:00:00.000Z",movieYear:2016,movieGenre:"Horror, Mystery, Thriller",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Blumhouse Productions;Monkeypaw Productions;QC Entertainment",movieDistributor:"Universal Pictures",score:99},
  {id:"62003",videoId:"HHnKnVUySJU",title:"Split | Official Trailer",channelTitle:"Universal Pictures",publishedAt:"2016-07-27T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/HHnKnVUySJU/hqdefault.jpg",durationSeconds:150,movieId:"61006",movieTitle:"Split",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Split_(2016_film)_poster.jpg?width=600",movieReleaseDate:"2017-01-20T00:00:00.000Z",movieYear:2016,movieGenre:"Psychological Thriller, Horror",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Blumhouse Productions;Blinding Edge Pictures",movieDistributor:"Universal Pictures",score:98},
  {id:"62005",videoId:"EXeTwQWrcwY",title:"The Dark Knight | Official Trailer",channelTitle:"Warner Bros. Pictures",publishedAt:"2007-12-14T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/EXeTwQWrcwY/hqdefault.jpg",durationSeconds:152,movieId:"61008",movieTitle:"The Dark Knight",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/The_Dark_Knight_(2008_film).jpg?width=600",movieReleaseDate:"2008-07-18T00:00:00.000Z",movieYear:2007,movieGenre:"Action, Crime, Drama",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Warner Bros. Pictures;Legendary Pictures;Syncopy",movieDistributor:"Warner Bros. Pictures",score:97},
  {id:"62006",videoId:"yJXTXN4xrI8",title:"Interstellar | Official Trailer",channelTitle:"Warner Bros. Pictures",publishedAt:"2014-05-16T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/yJXTXN4xrI8/hqdefault.jpg",durationSeconds:169,movieId:"61009",movieTitle:"Interstellar",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Interstellar_film_poster.jpg?width=600",movieReleaseDate:"2014-11-07T00:00:00.000Z",movieYear:2014,movieGenre:"Science Fiction, Adventure, Drama",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Paramount Pictures;Warner Bros. Pictures;Syncopy;Legendary Pictures",movieDistributor:"Paramount Pictures;Warner Bros. Pictures",score:96},
  {id:"62007",videoId:"zAGVQLHvwOY",title:"Joker | Official Trailer",channelTitle:"Warner Bros. Pictures",publishedAt:"2019-08-28T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/zAGVQLHvwOY/hqdefault.jpg",durationSeconds:151,movieId:"61010",movieTitle:"Joker",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Joker_(2019_film)_poster.jpg?width=600",movieReleaseDate:"2019-10-04T00:00:00.000Z",movieYear:2019,movieGenre:"Crime, Drama, Thriller",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Warner Bros. Pictures;Village Roadshow Pictures;DC Films",movieDistributor:"Warner Bros. Pictures",score:95},
  {id:"62008",videoId:"TcMBFSGVi1c",title:"Avengers: Endgame | Official Trailer",channelTitle:"Marvel Studios",publishedAt:"2019-03-14T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/TcMBFSGVi1c/hqdefault.jpg",durationSeconds:150,movieId:"61011",movieTitle:"Avengers: Endgame",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Avengers_Endgame_poster.jpg?width=600",movieReleaseDate:"2019-04-26T00:00:00.000Z",movieYear:2019,movieGenre:"Action, Adventure, Drama",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Marvel Studios;Walt Disney Pictures",movieDistributor:"Walt Disney Studios Motion Pictures",score:94},
  {id:"62009",videoId:"n9xhJrPXop4",title:"Dune | Official Trailer",channelTitle:"Warner Bros.",publishedAt:"2020-09-09T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/n9xhJrPXop4/hqdefault.jpg",durationSeconds:155,movieId:"61012",movieTitle:"Dune",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Dune_(2021_film)_poster.jpg?width=600",movieReleaseDate:"2021-10-22T00:00:00.000Z",movieYear:2020,movieGenre:"Science Fiction, Adventure, Drama",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Warner Bros. Pictures;Legendary Pictures",movieDistributor:"Warner Bros. Pictures",score:93},
  {id:"62010",videoId:"bK6ldnjE3Y0",title:"Oppenheimer | Official Trailer",channelTitle:"Universal Pictures",publishedAt:"2022-12-18T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/bK6ldnjE3Y0/hqdefault.jpg",durationSeconds:180,movieId:"61013",movieTitle:"Oppenheimer",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Oppenheimer_(film)_poster.jpg?width=600",movieReleaseDate:"2023-07-21T00:00:00.000Z",movieYear:2022,movieGenre:"Biography, Drama, History",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Universal Pictures;Syncopy;Atlas Entertainment",movieDistributor:"Universal Pictures",score:92},
  {id:"62011",videoId:"pBk4NYhWNMM",title:"Barbie | Official Trailer",channelTitle:"Warner Bros. Pictures",publishedAt:"2023-05-25T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/pBk4NYhWNMM/hqdefault.jpg",durationSeconds:153,movieId:"61014",movieTitle:"Barbie",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Barbie_(2023_film)_poster.jpg?width=600",movieReleaseDate:"2023-07-21T00:00:00.000Z",movieYear:2023,movieGenre:"Comedy, Fantasy, Adventure",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Warner Bros. Pictures;LuckyChap Entertainment;Heyday Films",movieDistributor:"Warner Bros. Pictures",score:91},
  {id:"62012",videoId:"qEVUtrk8_B4",title:"John Wick: Chapter 4 | Official Trailer",channelTitle:"Lionsgate Movies",publishedAt:"2022-11-10T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/qEVUtrk8_B4/hqdefault.jpg",durationSeconds:165,movieId:"61015",movieTitle:"John Wick: Chapter 4",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/John_Wick_Chapter_4_poster.jpg?width=600",movieReleaseDate:"2023-03-24T00:00:00.000Z",movieYear:2022,movieGenre:"Action, Crime, Thriller",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Lionsgate;Thunder Road Pictures",movieDistributor:"Lionsgate",score:90},
  {id:"62013",videoId:"qSqVVswa420",title:"Top Gun: Maverick | Official Trailer",channelTitle:"Paramount Pictures",publishedAt:"2019-07-18T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/qSqVVswa420/hqdefault.jpg",durationSeconds:150,movieId:"61016",movieTitle:"Top Gun: Maverick",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Top_Gun_Maverick_Poster.jpg?width=600",movieReleaseDate:"2022-05-27T00:00:00.000Z",movieYear:2019,movieGenre:"Action, Drama",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Paramount Pictures;Skydance;Jerry Bruckheimer Films",movieDistributor:"Paramount Pictures",score:89},
  {id:"62014",videoId:"JfVOs4VSpmA",title:"Spider-Man: No Way Home | Official Trailer",channelTitle:"Sony Pictures Entertainment",publishedAt:"2021-08-23T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/JfVOs4VSpmA/hqdefault.jpg",durationSeconds:183,movieId:"61017",movieTitle:"Spider-Man: No Way Home",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Spider-Man_No_Way_Home_poster.jpg?width=600",movieReleaseDate:"2021-12-17T00:00:00.000Z",movieYear:2021,movieGenre:"Action, Adventure, Science Fiction",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Columbia Pictures;Marvel Studios;Pascal Pictures",movieDistributor:"Sony Pictures Releasing",score:88},
  {id:"62015",videoId:"RFinNxS5KN4",title:"Jurassic World | Official Trailer",channelTitle:"Universal Pictures",publishedAt:"2014-11-25T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/RFinNxS5KN4/hqdefault.jpg",durationSeconds:150,movieId:"61018",movieTitle:"Jurassic World",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Jurassic_World_poster.jpg?width=600",movieReleaseDate:"2015-06-12T00:00:00.000Z",movieYear:2014,movieGenre:"Science Fiction, Adventure, Action",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Universal Pictures;Amblin Entertainment;Legendary Pictures",movieDistributor:"Universal Pictures",score:87},
  {id:"62016",videoId:"d9MyW72ELq0",title:"Avatar: The Way of Water | Official Trailer",channelTitle:"20th Century Studios",publishedAt:"2022-11-02T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/d9MyW72ELq0/hqdefault.jpg",durationSeconds:149,movieId:"61019",movieTitle:"Avatar: The Way of Water",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Avatar_The_Way_of_Water_poster.jpg?width=600",movieReleaseDate:"2022-12-16T00:00:00.000Z",movieYear:2022,movieGenre:"Science Fiction, Adventure, Action",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"20th Century Studios;Lightstorm Entertainment",movieDistributor:"20th Century Studios",score:86},
  {id:"62017",videoId:"0IOsk2Vlc4o",title:"Bullet Train | Official Trailer",channelTitle:"Sony Pictures Entertainment",publishedAt:"2022-03-02T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/0IOsk2Vlc4o/hqdefault.jpg",durationSeconds:152,movieId:"61020",movieTitle:"Bullet Train",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Bullet_Train_(film)_poster.jpg?width=600",movieReleaseDate:"2022-08-05T00:00:00.000Z",movieYear:2022,movieGenre:"Action, Comedy, Thriller",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Columbia Pictures;87North Productions",movieDistributor:"Sony Pictures Releasing",score:85},
  {id:"62018",videoId:"odM92ap8_c0",title:"Godzilla vs. Kong | Official Trailer",channelTitle:"Warner Bros. Pictures",publishedAt:"2021-01-24T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/odM92ap8_c0/hqdefault.jpg",durationSeconds:144,movieId:"61021",movieTitle:"Godzilla vs. Kong",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Godzilla_vs._Kong_poster.jpg?width=600",movieReleaseDate:"2021-03-26T00:00:00.000Z",movieYear:2021,movieGenre:"Action, Science Fiction",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Warner Bros. Pictures;Legendary Pictures",movieDistributor:"Warner Bros. Pictures",score:84},
  {id:"62019",videoId:"6ZfuNTqbHE8",title:"Avengers: Infinity War | Official Trailer",channelTitle:"Marvel Studios",publishedAt:"2017-11-29T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/6ZfuNTqbHE8/hqdefault.jpg",durationSeconds:150,movieId:"61022",movieTitle:"Avengers: Infinity War",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Avengers_Infinity_War_poster.jpg?width=600",movieReleaseDate:"2018-04-27T00:00:00.000Z",movieYear:2017,movieGenre:"Action, Adventure, Science Fiction",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Marvel Studios;Walt Disney Pictures",movieDistributor:"Walt Disney Studios Motion Pictures",score:83},
  {id:"62020",videoId:"Z1BCujX3pw8",title:"Captain Marvel | Official Trailer",channelTitle:"Marvel Studios",publishedAt:"2018-09-18T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/Z1BCujX3pw8/hqdefault.jpg",durationSeconds:116,movieId:"61023",movieTitle:"Captain Marvel",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Captain_Marvel_(film)_poster.jpg?width=600",movieReleaseDate:"2019-03-08T00:00:00.000Z",movieYear:2018,movieGenre:"Action, Adventure, Science Fiction",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Marvel Studios;Walt Disney Pictures",movieDistributor:"Walt Disney Studios Motion Pictures",score:82},
  {id:"62021",videoId:"xjDjIWPwcPU",title:"Black Panther | Official Trailer",channelTitle:"Marvel Studios",publishedAt:"2017-10-16T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/xjDjIWPwcPU/hqdefault.jpg",durationSeconds:140,movieId:"61024",movieTitle:"Black Panther",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Black_Panther_(film)_poster.jpg?width=600",movieReleaseDate:"2018-02-16T00:00:00.000Z",movieYear:2017,movieGenre:"Action, Adventure, Science Fiction",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Marvel Studios;Walt Disney Pictures",movieDistributor:"Walt Disney Studios Motion Pictures",score:81},
  {id:"62022",videoId:"ue80QwXMRHg",title:"Thor: Ragnarok | Official Trailer",channelTitle:"Marvel Studios",publishedAt:"2017-06-23T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/ue80QwXMRHg/hqdefault.jpg",durationSeconds:140,movieId:"61025",movieTitle:"Thor: Ragnarok",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Thor_Ragnarok_poster.jpg?width=600",movieReleaseDate:"2017-11-03T00:00:00.000Z",movieYear:2017,movieGenre:"Action, Adventure, Comedy",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Marvel Studios;Walt Disney Pictures",movieDistributor:"Walt Disney Studios Motion Pictures",score:80},
  {id:"62023",videoId:"V75dMMIW2B4",title:"The Lord of the Rings: The Fellowship of the Ring | Official Trailer",channelTitle:"New Line Cinema",publishedAt:"2001-06-01T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/V75dMMIW2B4/hqdefault.jpg",durationSeconds:155,movieId:"61026",movieTitle:"The Lord of the Rings: The Fellowship of the Ring",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/The_Lord_of_the_Rings_The_Fellowship_of_the_Ring_(2001).jpg?width=600",movieReleaseDate:"2001-12-19T00:00:00.000Z",movieYear:2001,movieGenre:"Fantasy, Adventure, Drama",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"New Line Cinema;WingNut Films",movieDistributor:"New Line Cinema",score:79},
  {id:"62024",videoId:"a8Gx8wiNbs8",title:"Doctor Strange in the Multiverse of Madness | Official Trailer",channelTitle:"Marvel Studios",publishedAt:"2022-02-14T00:00:00.000Z",thumbnailUrl:"https://i.ytimg.com/vi/a8Gx8wiNbs8/hqdefault.jpg",durationSeconds:145,movieId:"61027",movieTitle:"Doctor Strange in the Multiverse of Madness",moviePosterUrl:"https://commons.wikimedia.org/wiki/Special:FilePath/Doctor_Strange_in_the_Multiverse_of_Madness_poster.jpg?width=600",movieReleaseDate:"2022-05-06T00:00:00.000Z",movieYear:2022,movieGenre:"Action, Adventure, Fantasy",movieOriginalLanguage:"en",movieCountries:"United States",movieProductionCompanies:"Marvel Studios;Walt Disney Pictures",movieDistributor:"Walt Disney Studios Motion Pictures",score:78}
] as const;
function verifiedStaticPool():TrendingVideo[]{
  return VERIFIED_HOLLYWOOD_VIDEOS.map(v=>({
    provider:"youtube" as const,
    videoId:v.videoId,title:v.title,description:"Verified Hollywood movie trailer or official movie clip.",
    channelId:"",channelTitle:v.channelTitle,thumbnailUrl:v.thumbnailUrl,durationSeconds:v.durationSeconds,
    publishedAt:v.publishedAt,categoryId:"1",viewCount:0,likeCount:0,commentCount:0,liveBroadcastContent:"none",
    score:v.score,movieId:v.movieId,movieTitle:v.movieTitle,moviePosterUrl:v.moviePosterUrl,
    movieReleaseDate:v.movieReleaseDate,movieYear:v.movieYear,movieGenre:v.movieGenre,
    movieOriginalLanguage:v.movieOriginalLanguage,movieCountries:v.movieCountries,
    movieProductionCompanies:v.movieProductionCompanies,movieDistributor:v.movieDistributor
  }));
}
function shuffleTrending(pool:TrendingVideo[]){
  return [...pool].sort(()=>Math.random()-0.5);
}
async function ensureVerifiedHollywoodCache(){
  for(const videoId of INVALID_KNOWN_VIDEO_IDS){await prisma.trailerCache.updateMany({where:{videoId},data:{embeddable:false,lastValidatedAt:new Date(0)}}).catch(()=>{});}
  for(const v of VERIFIED_HOLLYWOOD_VIDEOS){
    const movie=await prisma.movie.findUnique({where:{id:v.movieId}});
    if(!movie||!isEligibleHollywoodMovie(movie))continue;
    const poster=await ensureMoviePoster(movie,v.moviePosterUrl);
    if(!poster){console.warn("[poster-validation]",{operation:"bootstrap",movieId:v.movieId,movieTitle:v.movieTitle,status:"unavailable"});continue;}
    await prisma.trailerCache.upsert({where:{videoId:v.videoId},create:{id:v.id,videoId:v.videoId,title:v.title,description:"Verified Hollywood movie promotional video.",channelId:"",channelTitle:v.channelTitle,publishedAt:new Date(v.publishedAt),thumbnailUrl:v.thumbnailUrl,durationSeconds:v.durationSeconds,categoryId:"1",viewCount:0,likeCount:0,commentCount:0,embeddable:true,privacyStatus:"public",score:v.score,lastValidatedAt:new Date(0),lastSeenAt:new Date(),createdAt:new Date(),updatedAt:new Date(),movieId:v.movieId,movieTitle:v.movieTitle,moviePosterUrl:poster,movieReleaseDate:new Date(v.movieReleaseDate),movieYear:v.movieYear,movieGenre:v.movieGenre,movieOriginalLanguage:v.movieOriginalLanguage,movieCountries:v.movieCountries,movieProductionCompanies:v.movieProductionCompanies,movieDistributor:v.movieDistributor,movieHollywoodEligible:true},update:{title:v.title,channelTitle:v.channelTitle,publishedAt:new Date(v.publishedAt),thumbnailUrl:v.thumbnailUrl,durationSeconds:v.durationSeconds,embeddable:true,privacyStatus:"public",score:v.score,lastValidatedAt:new Date(0),lastSeenAt:new Date(),movieId:v.movieId,movieTitle:v.movieTitle,moviePosterUrl:poster,movieReleaseDate:new Date(v.movieReleaseDate),movieYear:v.movieYear,movieGenre:v.movieGenre,movieOriginalLanguage:v.movieOriginalLanguage,movieCountries:v.movieCountries,movieProductionCompanies:v.movieProductionCompanies,movieDistributor:v.movieDistributor,movieHollywoodEligible:true}});
  }
}
const discoveryStateKey="trending_discovery_state";
type DiscoveryState={lastAttemptAt?:string;blockedUntil?:string;lastReason?:string;lastQuery?:string};
async function readDiscoveryState():Promise<DiscoveryState>{
  const row=await prisma.setting.findUnique({where:{key:discoveryStateKey}});if(!row)return {};
  try{return JSON.parse(row.value||"{}") as DiscoveryState;}catch{return {};}
}
async function writeDiscoveryState(state:DiscoveryState){
  await prisma.setting.upsert({where:{key:discoveryStateKey},create:{id:await uniqueSettingId(),key:discoveryStateKey,value:JSON.stringify(state)},update:{value:JSON.stringify(state)}});
}
async function discoveryAllowed(cfg:TrendingConfig){
  const state=await readDiscoveryState();
  const blockedUntil=state.blockedUntil?Date.parse(state.blockedUntil):0;
  return !blockedUntil||Date.now()>=blockedUntil;
}
async function discoverAndCache(cfg:TrendingConfig){
  if(!(await discoveryAllowed(cfg)))throw providerError("YOUTUBE_DISCOVERY_COOLDOWN","YouTube discovery is temporarily on cooldown; cached Hollywood movies remain authoritative.");
  const started=new Date();
  try{
    const movies=await getEligibleHollywoodMovies();if(!movies.length)throw providerError("NO_ELIGIBLE_HOLLYWOOD_MOVIE","No eligible Hollywood movie is configured.");
    const movie=movies[Math.floor(Math.random()*movies.length)];const pool=await discover(movie,cfg);await writeCache(pool);
    await writeDiscoveryState({lastAttemptAt:started.toISOString(),blockedUntil:new Date(Date.now()+cfg.discoveryCooldownMs).toISOString(),lastReason:"success",lastQuery:movie.title});return pool;
  }catch(error){
    const code=String((error as any)?.code||"YOUTUBE_API_ERROR");
    if(["YOUTUBE_QUOTA_EXHAUSTED","YOUTUBE_API_ERROR","NO_ELIGIBLE_HOLLYWOOD_MOVIE","YOUTUBE_ZERO_RESULTS","YOUTUBE_CANDIDATES_REJECTED","YOUTUBE_DISCOVERY_COOLDOWN"].includes(code))await writeDiscoveryState({lastAttemptAt:started.toISOString(),blockedUntil:new Date(Date.now()+cfg.discoveryCooldownMs).toISOString(),lastReason:code});
    throw error;
  }
}
export async function getTrendingVideosForClient(clientId:string,count:number){
  const cfg=await config();
  if(cfg.enabled){
    await ensureVerifiedHollywoodCache();
    const staticPool=verifiedStaticPool();
    const pool=await loadCache(cfg);
    // Keep the curated Hollywood pool authoritative even when some poster
    // hosts temporarily fail validation. This prevents the Client from
    // collapsing to only the few rows that happen to validate at that moment.
    if(pool.length>=count)return selectMany(clientId,pool,count,cfg);
    const merged=[...pool,...staticPool.filter(v=>!pool.some(p=>p.videoId===v.videoId))];
    if(merged.length>=count)return selectMany(clientId,merged,count,cfg);
    const stale=await loadCache(cfg,true);
    const staleMerged=[...stale,...staticPool.filter(v=>!stale.some(p=>p.videoId===v.videoId))];
    if(staleMerged.length>=count)return selectMany(clientId,staleMerged,count,cfg);
    try{
      const discovered=await discoverAndCache(cfg);
      if(discovered.length)return selectMany(clientId,[...discovered,...staticPool.filter(v=>!discovered.some(p=>p.videoId===v.videoId))],count,cfg);
    }catch(error){
      // Keep task start independent from YouTube API quota, search availability,
      // or embed restrictions. Prefer already cached/verified Hollywood videos,
      // then add only openly licensed direct-stream fallbacks hosted by Blender.
      const fallback=await loadCache(cfg,true).catch(()=>[]);
      const licensed=openLicensedFallback(clientId,OPEN_LICENSED_VIDEO_FALLBACKS.length);
      const fallbackPool=[
        ...fallback,
        ...staticPool.filter(v=>!fallback.some(p=>p.videoId===v.videoId)),
        ...licensed.filter(v=>!fallback.some(p=>p.videoId===v.videoId)&&!staticPool.some(p=>p.videoId===v.videoId))
      ];
      if(fallbackPool.length)return selectMany(clientId,fallbackPool,count,cfg);
    }
    // Last-resort mixed pool: cached/verified YouTube trailers plus licensed
    // native MP4 sources. The client already supports provider="direct".
    return selectMany(clientId,[
      ...staticPool,
      ...openLicensedFallback(clientId,OPEN_LICENSED_VIDEO_FALLBACKS.length)
        .filter(v=>!staticPool.some(p=>p.videoId===v.videoId))
    ],count,cfg);
  }
  return openLicensedFallback(clientId,count);
}
export async function getTrendingVideoForClient(clientId:string){return (await getTrendingVideosForClient(clientId,1))[0];}
export async function getAlternativeVideoForTask(clientId:string,movieTitle:string|null,excludeVideoId:string|null){
  const cfg=await config();
  // A failed YouTube playback should switch providers instead of repeatedly
  // cycling through other cached YouTube IDs. If a direct stream fails, the
  // normal cached-video path below can switch back to YouTube.
  if(excludeVideoId&&!/^https?:\/\//i.test(excludeVideoId)){
    const licensed=openLicensedFallback(clientId,OPEN_LICENSED_VIDEO_FALLBACKS.length).filter(v=>v.videoId!==excludeVideoId);
    if(licensed.length)return licensed[Math.floor(Math.random()*licensed.length)];
  }
  if(cfg.enabled){
    await ensureVerifiedHollywoodCache();
    const pool=await loadCache(cfg);
    const sameMovie=pool.filter(v=>(!movieTitle||v.movieTitle===movieTitle)&&v.videoId!==excludeVideoId);
    if(sameMovie.length)return (await selectMany(clientId,sameMovie,1,cfg))[0];
    const fallback=pool.filter(v=>v.videoId!==excludeVideoId);
    if(fallback.length)return (await selectMany(clientId,fallback,1,cfg))[0];
  }
  const pool=openLicensedFallback(clientId,OPEN_LICENSED_VIDEO_FALLBACKS.length).filter(v=>v.videoId!==excludeVideoId);
  return pool[Math.floor(Math.random()*pool.length)]||OPEN_LICENSED_VIDEO_FALLBACKS[0];
}
export async function getCurrentTrailerCandidates(){
  const cfg=await config();
  const licensed=openLicensedFallback("movie-preview",OPEN_LICENSED_VIDEO_FALLBACKS.length);
  if(!cfg.enabled)return shuffleTrending(licensed).slice(0,20);
  await ensureVerifiedHollywoodCache();
  const cached=await loadCache(cfg,true).catch(()=>[]);
  const staticPool=verifiedStaticPool();
  // Mix a small, explicitly licensed direct-stream set into Trending Now so
  // the Client exercises both native MP4 and YouTube playback paths. These
  // Blender Foundation films are fallback content, not copied copyrighted
  // Hollywood titles.
  const merged=[
    ...cached,
    ...staticPool.filter(v=>!cached.some(c=>c.videoId===v.videoId)),
    ...licensed.filter(v=>!cached.some(c=>c.videoId===v.videoId)&&!staticPool.some(c=>c.videoId===v.videoId))
  ];
  return shuffleTrending(merged).slice(0,20);
}
export async function runYouTubeDiagnostic(){return {skipped:true,reason:"manual-only diagnostic; production startup does not call search.list"};}
export async function warmTrendingVideoCache(){
  const cfg=await config();if(!cfg.enabled)return {enabled:false,count:0};
  const pool=await loadCache(cfg,true);
  console.log("[trending] cache warmup",{count:pool.length});
  return {enabled:true,count:pool.length};
}
export async function trendingConfig(){
  const cfg=await config();
  return {enabled:cfg.enabled,provider:"YouTube",regionCode:cfg.regionCode,relevanceLanguage:cfg.relevanceLanguage,cacheTtlMinutes:cfg.cacheTtlMs/60000,poolSize:cfg.poolSize,recentHistorySize:cfg.recentHistorySize,repeatCooldownHours:cfg.repeatCooldownHours,minDurationSeconds:cfg.minDurationSeconds,maxDurationSeconds:cfg.maxDurationSeconds,freshnessDays:cfg.freshnessDays,maxCandidates:cfg.maxCandidates,refreshIntervalMinutes:cfg.refreshIntervalMs/60000,discoveryCooldownMinutes:cfg.discoveryCooldownMs/60000,discoveryMaxAttempts:cfg.discoveryMaxAttempts};
}
