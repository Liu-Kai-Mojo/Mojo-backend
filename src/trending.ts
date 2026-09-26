import { prisma } from "./prisma.js";
import { uniqueSettingId } from "./utils/codes.js";

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
  const keys=["trending_videos_enabled","trending_region_code","trending_relevance_language","trending_cache_ttl_minutes","trending_pool_size","trending_recent_history_size","trending_repeat_cooldown_hours","trending_min_duration_seconds","trending_max_duration_seconds","trending_freshness_days","trending_max_candidates","trending_refresh_interval_minutes","trending_discovery_queries","trending_discovery_orders"];
  const values=await Promise.all(keys.map(readSetting));
  const env=process.env;
  const rawQueries=(values[12]??env.TRENDING_DISCOVERY_QUERIES??"new movie trailer|latest movie trailer|upcoming movie trailer|trending movie trailer|popular movie trailer|official movie trailer").split("|").map(v=>v.trim()).filter(Boolean);
  const rawOrders=(values[13]??env.TRENDING_DISCOVERY_ORDERS??"date|viewCount|relevance").split("|").map(v=>v.trim()).filter(v=>["date","viewCount","relevance"].includes(v));
  return {
    enabled:(values[0]??env.TRENDING_VIDEOS_ENABLED??"true").toLowerCase()!=="false",
    regionCode:((values[1]??env.YOUTUBE_REGION_CODE??env.TRENDING_REGION_CODE??"").trim().toUpperCase()==="MM"?"":(values[1]??env.YOUTUBE_REGION_CODE??env.TRENDING_REGION_CODE??"").trim().toUpperCase()),
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
    discoveryQueries:rawQueries.length?rawQueries:["official movie trailer"],
    discoveryOrders:rawOrders.length?rawOrders:["date","viewCount","relevance"]
  };
}
function parseDuration(value:string){
  const m=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value||"");
  return m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0;
}
function clean(value:string){return value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();}
function movieTitle(value:string){return clean(value).replace(/\s*[|–—:-]\s*(?:the\s+)?(?:official\s+)?(?:final\s+)?(?:movie\s+)?(?:official\s+)?(?:trailer|teaser)(?:\s*(?:#|part|pt\.?|\d+).*)?$/i,"").replace(/\s*\((?:official\s+)?(?:final\s+)?(?:trailer|teaser)\)$/i,"").replace(/\s+\b(?:official|new|latest|final)\s+trailer\b.*$/i,"").trim() || clean(value);}
const DEFAULT_INDIA_TITLE_EXCLUSIONS="";
const DEFAULT_INDIA_CHANNEL_EXCLUSIONS="";

const INDIA_TITLE_EXCLUSIONS=new RegExp(process.env.TRAILER_INDIA_TITLE_EXCLUSIONS||DEFAULT_INDIA_TITLE_EXCLUSIONS,"i");
const INDIA_CHANNEL_EXCLUSIONS=new RegExp(process.env.TRAILER_INDIA_CHANNEL_EXCLUSIONS||DEFAULT_INDIA_CHANNEL_EXCLUSIONS,"i");
function isLikelyTrailer(title:string,description:string,channelTitle=""){
  const titleText=title.toLowerCase();
  const channelText=channelTitle.toLowerCase();
  const positive=/\b(official\s+trailer|official\s+teaser(?:\s+trailer)?|final\s+trailer|new\s+trailer|movie\s+trailer|film\s+trailer|trailer|teaser)\b/.test(titleText);
  const negativeTitle=/\b(reaction|reacts|review|recap|explained|breakdown|fan\s*(made|trailer|edit)|parody|spoof|edit|shorts?|clip|scene|interview|behind\s+the\s+scenes|podcast|news|gameplay)\b/.test(titleText);
  const negativeChannel=/\b(reaction|review|recap|explained|breakdown|parody|spoof|shorts?|podcast|news|gameplay)\b/.test(channelText);
  if(INDIA_TITLE_EXCLUSIONS.test(title+" "+description)||INDIA_CHANNEL_EXCLUSIONS.test(channelTitle))return false;
  return positive&&!negativeTitle&&!negativeChannel;
}
function scoreVideo(v:TrendingVideo,cfg:TrendingConfig){
  const text=(v.title+" "+v.description+" "+v.channelTitle).toLowerCase();
  const ageDays=Math.max(0,(Date.now()-Date.parse(v.publishedAt))/86400000);
  const freshness=Number.isFinite(ageDays)?Math.max(0,30-Math.min(30,(ageDays/cfg.freshnessDays)*30)):0;
  const views=Math.min(30,Math.log10(Math.max(1,v.viewCount))*4);
  const velocity=Math.min(25,v.viewCount/Math.max(1,ageDays)/10000);
  const keyword=/official\s+trailer/.test(text)?40:/official\s+teaser/.test(text)?34:/\b(trailer|teaser)\b/.test(text)?24:0;
  const channel=/\bofficial\b|pictures|films?|studios?|entertainment|distribution|movies?/i.test(v.channelTitle)?8:0;
  const engagement=Math.min(10,Math.log10(Math.max(1,v.likeCount+v.commentCount))*2);
  return keyword+freshness+views+velocity+channel+engagement;
}
function rank(pool:TrendingVideo[],cfg:TrendingConfig){
  const map=new Map<string,TrendingVideo>();
  for(const v of pool){
    if(!v.videoId||map.has(v.videoId)||!isLikelyTrailer(v.title,v.description,v.channelTitle))continue;
    if(v.durationSeconds<cfg.minDurationSeconds)continue;
    if(cfg.maxDurationSeconds>0&&v.durationSeconds>cfg.maxDurationSeconds)continue;
    if(!v.thumbnailUrl||!v.publishedAt)continue;
    map.set(v.videoId,{...v,score:scoreVideo(v,cfg)});
  }
  return [...map.values()].sort((a,b)=>(b.score??0)-(a.score??0)).slice(0,cfg.poolSize);
}
async function youtubeRequest(url:URL,operation:string){
  let response:Response;
  try{response=await fetch(url,{signal:AbortSignal.timeout(9000)});}
  catch(error){if(error instanceof Error&&error.name==="TimeoutError")throw providerError("YOUTUBE_TIMEOUT",operation+" timed out.");throw providerError("YOUTUBE_SERVICE_UNAVAILABLE",operation+" could not be reached.");}
  if(!response.ok){
    let detail="";try{const body:any=await response.json();detail=String(body?.error?.errors?.[0]?.reason||body?.error?.status||"");}catch{}
    if(response.status===400)return providerError("YOUTUBE_INVALID_REQUEST","YouTube rejected the request."+detail);
    if(response.status===401)return providerError("YOUTUBE_AUTH_ERROR","YouTube authentication failed.");
    if(response.status===403)return providerError(/quota/i.test(detail)?"YOUTUBE_QUOTA_EXCEEDED":"YOUTUBE_AUTH_ERROR",/quota/i.test(detail)?"YouTube quota has been exceeded.":"YouTube authentication or API access was rejected.");
    if(response.status===404)return providerError("YOUTUBE_VIDEO_UNAVAILABLE","YouTube video data is unavailable.");
    if(response.status===429)return providerError("YOUTUBE_RATE_LIMIT","YouTube rate limit was reached.");
    if(response.status>=500)return providerError("YOUTUBE_SERVICE_UNAVAILABLE","YouTube is temporarily unavailable.");
    return providerError("YOUTUBE_UNKNOWN_ERROR","YouTube returned an unexpected response.");
  }
  return response.json() as Promise<any>;
}
async function discover(cfg:TrendingConfig){
  const key=process.env.YOUTUBE_API_KEY;
  if(!key)throw providerError("YOUTUBE_API_NOT_CONFIGURED","YOUTUBE_API_KEY is not configured on the backend.");
  const year=new Date().getUTCFullYear();
  const discoveryPairs=[
    {query:"new movie trailer",order:"date"},
    {query:"upcoming movie trailer",order:"date"},
    {query:"trending movie trailer",order:"viewCount"},
    {query:"popular movie trailer",order:"viewCount"},
    {query:"official movie trailer",order:"relevance"}
  ];
  const pair=discoveryPairs[queryCursor%discoveryPairs.length];
  queryCursor=(queryCursor+1)%discoveryPairs.length;
  const searchUrl=new URL("https://www.googleapis.com/youtube/v3/search");
  const searchResults:any[]=[];
  const searchPair=async (p:{query:string;order:string}, useFreshness:boolean)=>{
    const url=new URL(searchUrl);
    url.searchParams.set("part","snippet");
    url.searchParams.set("type","video");
    url.searchParams.set("videoEmbeddable","true");
    url.searchParams.set("order",p.order);
    if(cfg.regionCode)url.searchParams.set("regionCode",cfg.regionCode);
    url.searchParams.set("relevanceLanguage",cfg.relevanceLanguage);
    url.searchParams.set("maxResults",String(Math.min(25,Math.max(10,cfg.maxCandidates))));
    if(useFreshness)url.searchParams.set("publishedAfter",new Date(Date.now()-cfg.freshnessDays*86400000).toISOString());
    url.searchParams.set("q",p.query.replace(/\b20\d{2}\b/g,String(year)));
    url.searchParams.set("key",key);
    return youtubeRequest(url,"YouTube trailer search");
  };
  const first=await searchPair(pair,true);
  searchResults.push(first);
  let ids=[...new Set(searchResults.flatMap((search:any)=>Array.isArray(search.items)?search.items.map((x:any)=>String(x?.id?.videoId||"")).filter(Boolean):[]))].slice(0,50);
  console.log("[trending] YouTube discovery",{operation:"search",query:pair.query,order:pair.order,region:cfg.regionCode||"GLOBAL",resultCount:ids.length});
  if(!ids.length){
    const fallback=await searchPair(pair,false);
    searchResults.push(fallback);
    ids=[...new Set(searchResults.flatMap((search:any)=>Array.isArray(search.items)?search.items.map((x:any)=>String(x?.id?.videoId||"")).filter(Boolean):[]))].slice(0,50);
    console.log("[trending] YouTube discovery fallback",{query:pair.query,resultCount:ids.length});
  }
  if(!ids.length)throw providerError("NO_VALID_TRAILER","YouTube returned no trailer candidates.");
  const detailUrl=new URL("https://www.googleapis.com/youtube/v3/videos");
  detailUrl.searchParams.set("part","snippet,contentDetails,status,statistics");detailUrl.searchParams.set("id",ids.join(","));detailUrl.searchParams.set("key",key);
  const details:any=await youtubeRequest(detailUrl,"YouTube video validation");
  const candidates:TrendingVideo[]=[];
  for(const item of Array.isArray(details.items)?details.items:[]){
    const snippet=item.snippet||{}, status=item.status||{}, stats=item.statistics||{}, duration=parseDuration(String(item.contentDetails?.duration||""));
    const published=String(snippet.publishedAt||"");
    if(!item.id||String(status.privacyStatus)!=="public"||status.embeddable!==true||!published)continue;
    if(cfg.freshnessDays&&Date.parse(published)<Date.now()-Math.max(cfg.freshnessDays,365)*86400000)continue;
    if(!isLikelyTrailer(String(snippet.title||""),String(snippet.description||""),String(snippet.channelTitle||"")))continue;
    if(duration<cfg.minDurationSeconds||(cfg.maxDurationSeconds>0&&duration>cfg.maxDurationSeconds))continue;
    const thumb=String(snippet.thumbnails?.maxres?.url||snippet.thumbnails?.high?.url||snippet.thumbnails?.medium?.url||snippet.thumbnails?.default?.url||"");
    if(!thumb)continue;
    candidates.push({provider:"youtube",videoId:String(item.id),title:movieTitle(String(snippet.title||"")),description:String(snippet.description||""),channelId:String(snippet.channelId||""),channelTitle:clean(String(snippet.channelTitle||"")),thumbnailUrl:thumb,durationSeconds:duration,publishedAt:published,categoryId:String(snippet.categoryId||""),viewCount:Number(stats.viewCount||0),likeCount:Number(stats.likeCount||0),commentCount:Number(stats.commentCount||0),liveBroadcastContent:String(snippet.liveBroadcastContent||"none")});
  }
  let finalPool=rank(candidates,cfg);
  if(!finalPool.length){
    const fallbackPair=discoveryPairs[(queryCursor+1)%discoveryPairs.length];
    const fallback=await searchPair(fallbackPair,false);
    const fallbackIds=[...new Set(Array.isArray(fallback.items)?fallback.items.map((x:any)=>String(x?.id?.videoId||"")).filter(Boolean):[])].slice(0,50);
    if(fallbackIds.length){
      detailUrl.searchParams.set("id",fallbackIds.join(","));
      const fallbackDetails:any=await youtubeRequest(detailUrl,"YouTube fallback video validation");
      for(const item of Array.isArray(fallbackDetails.items)?fallbackDetails.items:[]){
        const snippet=item.snippet||{}, status=item.status||{}, stats=item.statistics||{}, duration=parseDuration(String(item.contentDetails?.duration||""));
        const published=String(snippet.publishedAt||"");
        if(!item.id||String(status.privacyStatus)!=="public"||status.embeddable!==true||!published)continue;
        if(!isLikelyTrailer(String(snippet.title||""),String(snippet.description||""),String(snippet.channelTitle||"")))continue;
        if(duration<cfg.minDurationSeconds||(cfg.maxDurationSeconds>0&&duration>cfg.maxDurationSeconds))continue;
        const thumb=String(snippet.thumbnails?.maxres?.url||snippet.thumbnails?.high?.url||snippet.thumbnails?.medium?.url||snippet.thumbnails?.default?.url||"");
        if(!thumb)continue;
        candidates.push({provider:"youtube",videoId:String(item.id),title:movieTitle(String(snippet.title||"")),description:String(snippet.description||""),channelId:String(snippet.channelId||""),channelTitle:clean(String(snippet.channelTitle||"")),thumbnailUrl:thumb,durationSeconds:duration,publishedAt:published,categoryId:String(snippet.categoryId||""),viewCount:Number(stats.viewCount||0),likeCount:Number(stats.likeCount||0),commentCount:Number(stats.commentCount||0),liveBroadcastContent:String(snippet.liveBroadcastContent||"none")});
      }
      finalPool=rank(candidates,cfg);
    }
  }
  console.log("[trending] YouTube validation",{candidateCount:candidates.length,validatedCount:finalPool.length});
  if(!finalPool.length)throw providerError("NO_VALID_TRAILER","No valid embeddable movie trailer was found.");
  return finalPool;
}
async function writeCache(pool:TrendingVideo[],cfg:TrendingConfig){
  const now=new Date();
  const ids=new Set(pool.map(v=>v.videoId));
  await prisma.trailerCache.deleteMany({where:{videoId:{notIn:[...ids]}}});
  for(const v of pool){
    await prisma.trailerCache.upsert({where:{videoId:v.videoId},create:{id:await uniqueSettingId(),videoId:v.videoId,title:v.title,description:v.description,channelId:v.channelId,channelTitle:v.channelTitle,publishedAt:new Date(v.publishedAt),thumbnailUrl:v.thumbnailUrl,durationSeconds:v.durationSeconds,categoryId:v.categoryId,viewCount:v.viewCount,likeCount:v.likeCount,commentCount:v.commentCount,embeddable:true,privacyStatus:"public",score:v.score??0,lastValidatedAt:now,lastSeenAt:now},update:{title:v.title,description:v.description,channelId:v.channelId,channelTitle:v.channelTitle,publishedAt:new Date(v.publishedAt),thumbnailUrl:v.thumbnailUrl,durationSeconds:v.durationSeconds,categoryId:v.categoryId,viewCount:v.viewCount,likeCount:v.likeCount,commentCount:v.commentCount,embeddable:true,privacyStatus:"public",score:v.score??0,lastValidatedAt:now,lastSeenAt:now}});
  }
}
function fromCache(row:any):TrendingVideo{return {provider:"youtube",videoId:row.videoId,title:movieTitle(row.title),description:row.description,channelId:row.channelId,channelTitle:row.channelTitle,thumbnailUrl:row.thumbnailUrl,durationSeconds:row.durationSeconds,publishedAt:row.publishedAt.toISOString(),categoryId:row.categoryId,viewCount:row.viewCount,likeCount:row.likeCount,commentCount:row.commentCount,liveBroadcastContent:"none",score:row.score};}
async function refresh(cfg:TrendingConfig){
  const running=refreshState.get(cacheKey);if(running)return running;
  const promise=discover(cfg).then(async pool=>{await writeCache(pool,cfg);return pool;}).finally(()=>refreshState.delete(cacheKey));
  refreshState.set(cacheKey,promise);return promise;
}
async function loadCache(cfg:TrendingConfig,allowStale=false){
  const cutoff=new Date(Date.now()-cfg.freshnessDays*86400000);
  const rows=await prisma.trailerCache.findMany({where:{embeddable:true,privacyStatus:"public",...(allowStale?{}:{publishedAt:{gte:cutoff},lastValidatedAt:{gte:cutoff}})},orderBy:{score:"desc"},take:cfg.poolSize});
  return rows.filter(row=>isLikelyTrailer(row.title,row.description,row.channelTitle)).slice(0,cfg.poolSize).map(fromCache);
}
async function select(clientId:string,pool:TrendingVideo[],cfg:TrendingConfig){
  if(!pool.length)throw providerError("TRAILER_CACHE_EMPTY","No validated YouTube trailer is currently cached.");
  const cutoff=new Date(Date.now()-cfg.repeatCooldownHours*3600000);
  const recent=await prisma.task.findMany({where:{clientId,videoId:{not:null},revealedAt:{gte:cutoff}},select:{videoId:true},orderBy:{revealedAt:"desc"},take:cfg.recentHistorySize});
  const recentIds=new Set(recent.map(x=>String(x.videoId)));
  const available=pool.filter(v=>!recentIds.has(v.videoId));
  const candidates=available.length?available:pool;
  return candidates[Math.floor(Math.random()*candidates.length)];
}
export async function getTrendingVideoForClient(clientId:string){
  const cfg=await config();
  if(!cfg.enabled)throw providerError("TRAILER_TASKS_DISABLED","Movie trailer tasks are temporarily unavailable.");
  const pool=await loadCache(cfg);
  if(pool.length){void refresh(cfg).catch(error=>console.error("[trending] background refresh failed",(error as any)?.code||"UNKNOWN"));return select(clientId,pool,cfg);}
  const stale=await loadCache(cfg,true);
  if(stale.length){void refresh(cfg).catch(error=>console.error("[trending] stale-cache refresh failed",(error as any)?.code||"UNKNOWN"));return select(clientId,stale,cfg);}

  try{return select(clientId,await refresh(cfg),cfg);}
  catch(error){
    const stale=await prisma.trailerCache.findMany({where:{embeddable:true,privacyStatus:"public"},orderBy:{score:"desc"},take:cfg.poolSize});
    const validatedStale=stale.filter(row=>isLikelyTrailer(row.title,row.description,row.channelTitle));if(validatedStale.length)return select(clientId,validatedStale.map(fromCache),cfg);
    throw error;
  }
}
export async function getCurrentTrailerCandidates(){
  const cfg=await config();
  const pool=await loadCache(cfg);
  if(pool.length)return pool;
  const stale=await loadCache(cfg,true);
  if(stale.length){void refresh(cfg).catch(()=>{});return stale;}
  try{return await refresh(cfg);}catch{return [];}
}
export async function warmTrendingVideoCache(){
  const cfg=await config();if(!cfg.enabled)return {enabled:false,count:0};
  const pool=await loadCache(cfg);
  if(pool.length&&Date.now()-Date.parse(pool[0].publishedAt)<=cfg.cacheTtlMs)return {enabled:true,count:pool.length};
  try{const fresh=await refresh(cfg);return {enabled:true,count:fresh.length};}
  catch(error){console.error("[trending] scheduled refresh failed",(error as any)?.code||"UNKNOWN",error instanceof Error?error.message:"unknown");return {enabled:true,count:pool.length};}
}
export async function trendingConfig(){
  const cfg=await config();
  return {enabled:cfg.enabled,provider:"YouTube",regionCode:cfg.regionCode,relevanceLanguage:cfg.relevanceLanguage,cacheTtlMinutes:cfg.cacheTtlMs/60000,poolSize:cfg.poolSize,recentHistorySize:cfg.recentHistorySize,repeatCooldownHours:cfg.repeatCooldownHours,minDurationSeconds:cfg.minDurationSeconds,maxDurationSeconds:cfg.maxDurationSeconds,freshnessDays:cfg.freshnessDays,maxCandidates:cfg.maxCandidates,refreshIntervalMinutes:cfg.refreshIntervalMs/60000,discoveryQueries:cfg.discoveryQueries,discoveryOrders:cfg.discoveryOrders};
}
