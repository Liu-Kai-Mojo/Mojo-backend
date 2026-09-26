import { prisma } from "./prisma.js";
import { uniqueSettingId } from "./utils/codes.js";
import { getEligibleHollywoodMovies, isEligibleHollywoodMovie, moviePosterIsUsable, type EligibleMovie } from "./movieCatalog.js";

export type TrendingVideo = {
  provider:"youtube";
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
  discoveryQueries:string[];
  discoveryOrders:string[];
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
  const keys=["trending_videos_enabled","trending_region_code","trending_relevance_language","trending_cache_ttl_minutes","trending_pool_size","trending_recent_history_size","trending_repeat_cooldown_hours","trending_min_duration_seconds","trending_max_duration_seconds","trending_freshness_days","trending_max_candidates","trending_refresh_interval_minutes","trending_discovery_cooldown_minutes","trending_discovery_queries","trending_discovery_orders"];
  const values=await Promise.all(keys.map(readSetting));
  const env=process.env;
  const rawQueries=(values[13]??env.TRENDING_DISCOVERY_QUERIES??"new movie trailer|latest movie trailer|upcoming movie trailer|trending movie trailer|popular movie trailer|official movie trailer").split("|").map(v=>v.trim()).filter(Boolean);
  const rawOrders=(values[14]??env.TRENDING_DISCOVERY_ORDERS??"date|viewCount|relevance").split("|").map(v=>v.trim()).filter(v=>["date","viewCount","relevance"].includes(v));
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
    discoveryQueries:rawQueries.length?rawQueries:["official movie trailer"],
    discoveryOrders:rawOrders.length?rawOrders:["date","viewCount","relevance"]
  };
}
function parseDuration(value:string){
  const m=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value||"");
  return m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0;
}
function clean(value:string){return value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();}
export function normalizeMovieTitle(value:string){const raw=clean(value).replace(/\s+/g," ");if(!raw)return "Movie";return raw.replace(/\s*[|–—:-]\s*(?:the\s+)?(?:new\s+|latest\s+|official\s+|exclusive\s+|final\s+|movie\s+)*(?:official\s+)?(?:trailer|teaser)(?:\s*(?:#|part|pt\.?|\d+).*)?$/i,"").replace(/\s*\((?:the\s+)?(?:new\s+|latest\s+|official\s+|exclusive\s+|final\s+)?(?:trailer|teaser)(?:\s*(?:#|part|pt\.?|\d+).*)?\)$/i,"").replace(/\s+\b(?:official|new|latest|exclusive|final)\s+(?:trailer|teaser)\b.*$/i,"").replace(/\s*[-–—|]+\s*$/,"").trim()||raw;}
const DEFAULT_INDIA_TITLE_EXCLUSIONS="";
const DEFAULT_INDIA_CHANNEL_EXCLUSIONS="";

const INDIA_TITLE_EXCLUSIONS=new RegExp(process.env.TRAILER_INDIA_TITLE_EXCLUSIONS||DEFAULT_INDIA_TITLE_EXCLUSIONS,"i");
const INDIA_CHANNEL_EXCLUSIONS=new RegExp(process.env.TRAILER_INDIA_CHANNEL_EXCLUSIONS||DEFAULT_INDIA_CHANNEL_EXCLUSIONS,"i");
function isLikelyTrailer(title:string,description:string,channelTitle=""){
  const titleText=String(title||"").toLowerCase();
  const channelText=String(channelTitle||"").toLowerCase();
  const negativeTitle=/\\b(reaction|reacts|review|recap|explained|breakdown|fan\\s*(made|trailer|edit)|parody|spoof|edit|shorts?|clip|scene|interview|behind\\s+the\\s+scenes|podcast|news|gameplay|song|lyric|ost)\\b/i.test(titleText);
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
  const queries=[movie.title+" official trailer",movie.title+" trailer",movie.title+" movie clip",movie.title+" official clip"];
  const searchResults:any[]=[];let ids:string[]=[];let lastQuery="";
  for(const query of queries){
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
  for(const v of pool)await prisma.trailerCache.upsert({where:{videoId:v.videoId},create:{id:await uniqueSettingId(),videoId:v.videoId,title:v.title,description:v.description,channelId:v.channelId,channelTitle:v.channelTitle,publishedAt:new Date(v.publishedAt),thumbnailUrl:v.thumbnailUrl,durationSeconds:v.durationSeconds,categoryId:v.categoryId,viewCount:v.viewCount,likeCount:v.likeCount,commentCount:v.commentCount,embeddable:true,privacyStatus:"public",score:v.score??0,lastValidatedAt:now,lastSeenAt:now,movieId:v.movieId,movieTitle:v.movieTitle,moviePosterUrl:v.moviePosterUrl,movieReleaseDate:v.movieReleaseDate?new Date(v.movieReleaseDate):null,movieYear:v.movieYear,movieGenre:v.movieGenre,movieOriginalLanguage:v.movieOriginalLanguage,movieCountries:v.movieCountries,movieProductionCompanies:v.movieProductionCompanies,movieDistributor:v.movieDistributor,movieHollywoodEligible:true},update:{title:v.title,description:v.description,channelId:v.channelId,channelTitle:v.channelTitle,publishedAt:new Date(v.publishedAt),thumbnailUrl:v.thumbnailUrl,durationSeconds:v.durationSeconds,categoryId:v.categoryId,viewCount:v.viewCount,likeCount:v.likeCount,commentCount:v.commentCount,embeddable:true,privacyStatus:"public",score:v.score??0,lastValidatedAt:now,lastSeenAt:now,movieId:v.movieId,movieTitle:v.movieTitle,moviePosterUrl:v.moviePosterUrl,movieReleaseDate:v.movieReleaseDate?new Date(v.movieReleaseDate):null,movieYear:v.movieYear,movieGenre:v.movieGenre,movieOriginalLanguage:v.movieOriginalLanguage,movieCountries:v.movieCountries,movieProductionCompanies:v.movieProductionCompanies,movieDistributor:v.movieDistributor,movieHollywoodEligible:true}});
}
function fromCache(row:any):TrendingVideo{return {provider:"youtube",videoId:row.videoId,title:row.title,description:row.description,channelId:row.channelId,channelTitle:row.channelTitle,thumbnailUrl:row.thumbnailUrl,durationSeconds:row.durationSeconds,publishedAt:row.publishedAt.toISOString(),categoryId:row.categoryId,viewCount:row.viewCount,likeCount:row.likeCount,commentCount:row.commentCount,liveBroadcastContent:"none",score:row.score,movieId:String(row.movieId),movieTitle:String(row.movieTitle),moviePosterUrl:String(row.moviePosterUrl),movieReleaseDate:row.movieReleaseDate?row.movieReleaseDate.toISOString():null,movieYear:Number(row.movieYear||0),movieGenre:String(row.movieGenre||""),movieOriginalLanguage:String(row.movieOriginalLanguage||""),movieCountries:String(row.movieCountries||""),movieProductionCompanies:String(row.movieProductionCompanies||""),movieDistributor:String(row.movieDistributor||"")};}
async function loadCache(cfg:TrendingConfig,allowStale=false){
  const cutoff=new Date(Date.now()-cfg.freshnessDays*86400000);
  const rows=await prisma.trailerCache.findMany({where:{embeddable:true,privacyStatus:"public",movieHollywoodEligible:true,movieId:{not:null},movieTitle:{not:null},moviePosterUrl:{not:null},...(allowStale?{}:{lastValidatedAt:{gte:cutoff}})},orderBy:{score:"desc"},take:Math.max(cfg.poolSize,50)});
  // TrailerCache rows have already passed backend validation when discovered.
  // Task-derived rows are also trusted because they were previously assigned by
  // the same backend pipeline; do not re-run title heuristics on normalized titles.
  return rows.slice(0,cfg.poolSize).map(fromCache);
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
  const cfg=await config();if(!cfg.enabled)throw providerError("YOUTUBE_API_ERROR","Movie trailer tasks are temporarily unavailable.");
  const pool=await loadCache(cfg);if(pool.length)return selectMany(clientId,pool,count,cfg);
  const stale=await loadCache(cfg,true);if(stale.length)return selectMany(clientId,stale,count,cfg);
  try{const discovered=await discoverAndCache(cfg);return selectMany(clientId,discovered,count,cfg);}
  catch(error){const fallback=await loadCache(cfg,true);if(fallback.length)return selectMany(clientId,fallback,count,cfg);throw error;}
}
export async function getTrendingVideoForClient(clientId:string){return (await getTrendingVideosForClient(clientId,1))[0];}
export async function getCurrentTrailerCandidates(){
  const cfg=await config();if(!cfg.enabled)return [];
  await hydrateCacheFromTasks();
  return loadCache(cfg,true);
}
export async function runYouTubeDiagnostic(){return {skipped:true,reason:"manual-only diagnostic; production startup does not call search.list"};}
export async function warmTrendingVideoCache(){
  const cfg=await config();if(!cfg.enabled)return {enabled:false,count:0};
  const hydrated=await hydrateCacheFromTasks();
  const pool=await loadCache(cfg,true);
  console.log("[trending] cache warmup",{count:pool.length,hydrated});
  return {enabled:true,count:pool.length,hydrated};
}
export async function trendingConfig(){
  const cfg=await config();
  return {enabled:cfg.enabled,provider:"YouTube",regionCode:cfg.regionCode,relevanceLanguage:cfg.relevanceLanguage,cacheTtlMinutes:cfg.cacheTtlMs/60000,poolSize:cfg.poolSize,recentHistorySize:cfg.recentHistorySize,repeatCooldownHours:cfg.repeatCooldownHours,minDurationSeconds:cfg.minDurationSeconds,maxDurationSeconds:cfg.maxDurationSeconds,freshnessDays:cfg.freshnessDays,maxCandidates:cfg.maxCandidates,refreshIntervalMinutes:cfg.refreshIntervalMs/60000,discoveryCooldownMinutes:cfg.discoveryCooldownMs/60000,discoveryQueries:cfg.discoveryQueries,discoveryOrders:cfg.discoveryOrders};
}
