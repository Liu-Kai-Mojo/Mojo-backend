import { prisma } from "./prisma.js";

export type TrendingVideo = {
  provider:"youtube";
  videoId:string;
  title:string;
  channelId:string;
  channelTitle:string;
  thumbnailUrl:string;
  durationSeconds:number;
  publishedAt:string;
  categoryId:string;
  description:string;
  viewCount:number;
  likeCount:number;
  commentCount:number;
  liveBroadcastContent:string;
  tmdbMovieId?:number;
  movieTitle?:string;
  moviePosterUrl?:string;
  movieReleaseDate?:string|null;
};

type TrendingConfig = {
  enabled:boolean;
  regionCode:string;
  categoryId:string;
  cacheTtlMs:number;
  poolSize:number;
  recentHistorySize:number;
  minDurationSeconds:number;
  maxDurationSeconds:number;
  freshnessDays:number;
  discoveryQueries:string[];
};

type CacheState = { expiresAt:number; value:TrendingVideo[] };
const cacheKey="trending_movie_trailer_cache";
const cacheState = new Map<string,CacheState>();
const refreshState = new Map<string,Promise<TrendingVideo[]>>();
const recentState = new Map<string,string[]>();

function providerError(code:string,message:string){const error=new Error(message);(error as any).code=code;return error;}
function classifyUpstream(status:number,provider:"TMDB"|"YOUTUBE"){if(status===401||status===403)return provider==="TMDB"?"TMDB_AUTH_ERROR":"YOUTUBE_AUTH_ERROR";if(status===404)return provider==="TMDB"?"TMDB_NOT_FOUND":"YOUTUBE_VIDEO_UNAVAILABLE";if(status===429)return provider==="TMDB"?"TMDB_RATE_LIMIT":"YOUTUBE_QUOTA_EXCEEDED";if(status>=500)return provider==="TMDB"?"TMDB_SERVICE_UNAVAILABLE":"YOUTUBE_SERVICE_UNAVAILABLE";return provider==="TMDB"?"TMDB_INVALID_REQUEST":"YOUTUBE_INVALID_REQUEST";}
function numberSetting(value:string|undefined,fallback:number){
  const n=Number(value);
  return Number.isFinite(n)&&n>=0?n:fallback;
}
async function readSetting(key:string){const row=await prisma.setting.findUnique({where:{key}});return row?.value;}
async function config():Promise<TrendingConfig>{
  const values=await Promise.all([
    readSetting("trending_videos_enabled"),readSetting("trending_region_code"),readSetting("trending_category_id"),
    readSetting("trending_cache_ttl_minutes"),readSetting("trending_pool_size"),readSetting("trending_recent_history_size"),
    readSetting("trending_min_duration_seconds"),readSetting("trending_max_duration_seconds"),
    readSetting("trending_freshness_days"),readSetting("trending_discovery_queries")
  ]);
  const env=process.env;
  const rawQueries=(values[9]??env.TRENDING_DISCOVERY_QUERIES??"official movie trailer|official teaser|new movie trailer|upcoming movie trailer").split("|").map(v=>v.trim()).filter(Boolean);
  return {
    enabled:(values[0]??env.TRENDING_VIDEOS_ENABLED??"true").toLowerCase()!=="false",
    regionCode:(values[1]??env.TRENDING_REGION_CODE??"MM").trim().toUpperCase(),
    categoryId:(values[2]??env.TRENDING_CATEGORY_ID??"1").trim(),
    cacheTtlMs:numberSetting(values[3]??env.TRENDING_CACHE_TTL_MINUTES,15)*60_000,
    poolSize:Math.max(10,Math.min(50,Math.floor(numberSetting(values[4]??env.TRENDING_POOL_SIZE,40)))),
    recentHistorySize:Math.max(1,Math.min(50,Math.floor(numberSetting(values[5]??env.TRENDING_RECENT_HISTORY_SIZE,10)))),
    minDurationSeconds:Math.floor(numberSetting(values[6]??env.TRENDING_MIN_DURATION_SECONDS,45)),
    maxDurationSeconds:Math.floor(numberSetting(values[7]??env.TRENDING_MAX_DURATION_SECONDS,0)),
    freshnessDays:Math.max(0,Math.min(3650,Math.floor(numberSetting(values[8]??env.TRENDING_FRESHNESS_DAYS,30)))),
    discoveryQueries:rawQueries
  };
}
function parseDuration(value:string){
  const m=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value||"");
  if(!m)return 0;
  return Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0);
}
function cleanTitle(title:string){return title.replace(/&quot;/g,'"').replace(/&#39;/g,"'");}
function looksLikeTrailer(title:string,description:string){
  const text=(title+" "+description).toLowerCase();
  const include=/\b(official\s+)?(movie\s+)?(trailer|teaser)(\s+trailer)?\b|official\s+teaser/.test(text);
  const exclude=/\b(reaction|reacts|review|recap|explained|ending|fan\s*(made|edit)|parody|spoof|shorts?)\b/.test(text);
  return include&&!exclude;
}
function scoreVideo(v:TrendingVideo,cfg:TrendingConfig){
  const text=(v.title+" "+v.channelTitle).toLowerCase();
  let score=0;
  if(/official\s+trailer/.test(text))score+=40;
  else if(/official\s+teaser/.test(text))score+=34;
  else if(/\btrailer\b/.test(text))score+=25;
  if(/\bfilm|movie|cinema\b/.test(text))score+=8;
  const ageDays=Math.max(0,(Date.now()-Date.parse(v.publishedAt))/86400000);
  if(Number.isFinite(ageDays)){
    score+=Math.max(0,25-(ageDays/cfg.freshnessDays)*25);
  }
  score+=Math.min(25,Math.log10(Math.max(1,v.viewCount))*4);
  return score;
}
function dedupeAndRank(pool:TrendingVideo[],cfg:TrendingConfig){
  const map=new Map<string,TrendingVideo>();
  for(const v of pool)if(v.videoId&&!map.has(v.videoId))map.set(v.videoId,v);
  return [...map.values()].filter(v=>looksLikeTrailer(v.title,v.description)).sort((a,b)=>scoreVideo(b,cfg)-scoreVideo(a,cfg)).slice(0,cfg.poolSize);
}
async function youtubeFetch(cfg:TrendingConfig){
  const key=process.env.YOUTUBE_API_KEY||process.env.YOUTUBE_DATA_API_KEY||"";
  if(!key)return [];
  const publishedAfter=cfg.freshnessDays?new Date(Date.now()-cfg.freshnessDays*86400000).toISOString():undefined;
  const candidates=new Map<string,{id:string;snippet:any}>();
  for(const q of cfg.discoveryQueries.slice(0,4)){
    const url=new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part","snippet");url.searchParams.set("type","video");url.searchParams.set("videoEmbeddable","true");
    url.searchParams.set("order","viewCount");url.searchParams.set("regionCode",cfg.regionCode);url.searchParams.set("maxResults","25");url.searchParams.set("q",q);url.searchParams.set("key",key);
    if(publishedAfter)url.searchParams.set("publishedAfter",publishedAfter);
    let rr:Response;try{rr=await fetch(url,{signal:AbortSignal.timeout(10000)});}catch(error){if(error instanceof Error&&error.name==="TimeoutError")throw providerError("YOUTUBE_TIMEOUT","YouTube discovery timed out.");throw providerError("YOUTUBE_NETWORK_ERROR","YouTube discovery could not be reached.");}
    if(!rr.ok)throw providerError(classifyUpstream(rr.status,"YOUTUBE"),"YouTube discovery is temporarily unavailable.");
    const jj:any=await rr.json();
    for(const item of Array.isArray(jj.items)?jj.items:[]){
      const id=String(item.id?.videoId||"");if(id)candidates.set(id,{id,snippet:item.snippet||{}});
    }
  }
  if(!candidates.size)return [];
  const ids=[...candidates.keys()].slice(0,50);
  const url=new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part","snippet,contentDetails,status,statistics");url.searchParams.set("id",ids.join(","));url.searchParams.set("key",key);
  let rr:Response;try{rr=await fetch(url,{signal:AbortSignal.timeout(10000)});}catch(error){if(error instanceof Error&&error.name==="TimeoutError")throw providerError("YOUTUBE_TIMEOUT","YouTube metadata request timed out.");throw providerError("YOUTUBE_NETWORK_ERROR","YouTube metadata could not be reached.");}
  if(!rr.ok)throw providerError(classifyUpstream(rr.status,"YOUTUBE"),"YouTube metadata is temporarily unavailable.");
  const jj:any=await rr.json();const out:TrendingVideo[]=[];
  for(const item of Array.isArray(jj.items)?jj.items:[]){
    const snippet=item.snippet||{};const duration=parseDuration(String(item.contentDetails?.duration||""));
    const privacy=String(item.status?.privacyStatus||"");const embeddable=item.status?.embeddable===true;
    if(!item.id||privacy!=="public"||!embeddable||duration<cfg.minDurationSeconds)continue;
    if(cfg.maxDurationSeconds>0&&duration>cfg.maxDurationSeconds)continue;
    const published=String(snippet.publishedAt||"");
    if(cfg.freshnessDays&&Date.parse(published)<Date.now()-cfg.freshnessDays*86400000)continue;
    out.push({provider:"youtube",videoId:String(item.id),title:cleanTitle(String(snippet.title||"")),description:String(snippet.description||""),channelId:String(snippet.channelId||""),channelTitle:String(snippet.channelTitle||""),thumbnailUrl:String(snippet.thumbnails?.high?.url||snippet.thumbnails?.medium?.url||snippet.thumbnails?.default?.url||""),durationSeconds:duration,publishedAt:published,categoryId:String(snippet.categoryId||""),viewCount:Number(item.statistics?.viewCount||0),likeCount:Number(item.statistics?.likeCount||0),commentCount:Number(item.statistics?.commentCount||0),liveBroadcastContent:String(snippet.liveBroadcastContent||"none")});
  }
  return dedupeAndRank(out,cfg);
}
async function tmdbFetch(cfg:TrendingConfig){
  const token=process.env.TMDB_API_READ_TOKEN||"";const apiKey=process.env.TMDB_API_KEY||process.env.TMDB_API||"";if(!token&&!apiKey)return [];
  const headers=token?{Authorization:"Bearer "+token}:{accept:"application/json"};
  const region=encodeURIComponent(cfg.regionCode);
  const endpoints=[
    "https://api.themoviedb.org/3/movie/now_playing?language=en-US&page=1&region="+region,
    "https://api.themoviedb.org/3/movie/upcoming?language=en-US&page=1&region="+region,
    "https://api.themoviedb.org/3/movie/popular?language=en-US&page=1&region="+region
  ].map(url=>token?url:url+"&api_key="+encodeURIComponent(apiKey));
  const movies:any[]=[];
  for(const url of endpoints){
    let rr:Response;try{rr=await fetch(url,{headers,signal:AbortSignal.timeout(8000)});}catch(error){if(error instanceof Error&&error.name==="TimeoutError")throw providerError("TMDB_TIMEOUT","TMDB request timed out.");throw providerError("TMDB_SERVICE_UNAVAILABLE","TMDB could not be reached.");}
    if(!rr.ok)throw providerError(classifyUpstream(rr.status,"TMDB"),"Movie discovery is temporarily unavailable.");
    const data:any=await rr.json();for(const movie of Array.isArray(data.results)?data.results:[])movies.push(movie);
  }
  const unique=movies.filter((m,i,a)=>m?.id&&a.findIndex(x=>x?.id===m.id)===i).sort((a,b)=>Number(b.popularity||0)-Number(a.popularity||0)).slice(0,15);
  const candidateMap=new Map<string,any>();
  for(const movie of unique){
    try{
      const url="https://api.themoviedb.org/3/movie/"+movie.id+"?append_to_response=videos&language=en-US"+(token?"":"&api_key="+encodeURIComponent(apiKey));
      const rr=await fetch(url,{headers,signal:AbortSignal.timeout(8000)});if(!rr.ok)continue;
      const detail:any=await rr.json();const videos=Array.isArray(detail.videos?.results)?detail.videos.results:[];
      const candidates=videos.filter((v:any)=>v.site==="YouTube"&&(v.type==="Trailer"||v.type==="Teaser")&&v.key).sort((a:any,b:any)=>Number(b.official===true)-Number(a.official===true));
      const selected=candidates[0];if(!selected?.key)continue;
      candidateMap.set(String(selected.key),{movie,selected});
    }catch{}
  }
  if(!candidateMap.size)return [];
  return [...candidateMap.values()].map(({movie,selected})=>({provider:"youtube",videoId:String(selected.key),title:String(selected.name||movie.title||"Movie Trailer"),description:String(movie.overview||""),channelId:"",channelTitle:"",thumbnailUrl:"https://i.ytimg.com/vi/"+selected.key+"/hqdefault.jpg",durationSeconds:0,publishedAt:String(selected.published_at||movie.release_date||""),categoryId:cfg.categoryId,viewCount:0,likeCount:0,commentCount:0,liveBroadcastContent:"none",tmdbMovieId:Number(movie.id),movieTitle:String(movie.title||""),moviePosterUrl:movie.poster_path?"https://image.tmdb.org/t/p/w780"+movie.poster_path:"",movieReleaseDate:movie.release_date?String(movie.release_date):null}));
}
async function youtubeValidateCandidates(candidates:TrendingVideo[],cfg:TrendingConfig){
  const key=process.env.YOUTUBE_API_KEY||process.env.YOUTUBE_DATA_API_KEY||"";if(!key||!candidates.length)return [];
  const ids=[...new Set(candidates.map(v=>v.videoId))].slice(0,50);const url=new URL("https://www.googleapis.com/youtube/v3/videos");url.searchParams.set("part","snippet,contentDetails,status,statistics");url.searchParams.set("id",ids.join(","));url.searchParams.set("key",key);
  let rr:Response;try{rr=await fetch(url,{signal:AbortSignal.timeout(10000)});}catch(error){if(error instanceof Error&&error.name==="TimeoutError")throw providerError("YOUTUBE_TIMEOUT","YouTube metadata request timed out.");throw providerError("YOUTUBE_NETWORK_ERROR","YouTube metadata could not be reached.");}
  if(!rr.ok)throw providerError(classifyUpstream(rr.status,"YOUTUBE"),"YouTube metadata is temporarily unavailable.");
  const data:any=await rr.json();const byId=new Map<string,any>((Array.isArray(data.items)?data.items:[]).map((x:any)=>[String(x.id),x]));const out:TrendingVideo[]=[];
  for(const candidate of candidates){const item=byId.get(candidate.videoId);if(!item)continue;const snippet=item.snippet||{};const duration=parseDuration(String(item.contentDetails?.duration||""));if(String(item.status?.privacyStatus||"")!=="public"||item.status?.embeddable!==true||duration<cfg.minDurationSeconds)continue;const published=String(snippet.publishedAt||candidate.publishedAt||"");if(cfg.freshnessDays&&published&&Date.parse(published)<Date.now()-cfg.freshnessDays*86400000)continue;out.push({...candidate,title:cleanTitle(String(snippet.title||candidate.title)),description:String(snippet.description||candidate.description||""),channelId:String(snippet.channelId||""),channelTitle:String(snippet.channelTitle||""),thumbnailUrl:String(snippet.thumbnails?.high?.url||snippet.thumbnails?.medium?.url||candidate.thumbnailUrl),durationSeconds:duration,publishedAt:published,categoryId:String(snippet.categoryId||candidate.categoryId),viewCount:Number(item.statistics?.viewCount||0),likeCount:Number(item.statistics?.likeCount||0),commentCount:Number(item.statistics?.commentCount||0),liveBroadcastContent:String(snippet.liveBroadcastContent||"none")});}
  return dedupeAndRank(out,cfg);
}

async function fetchTrending(cfg:TrendingConfig){
  let pool:TrendingVideo[]=[];
  try{const movieCandidates=await tmdbFetch(cfg);pool=await youtubeValidateCandidates(movieCandidates,cfg);}catch(error){console.error("[trending] movie/trailer discovery failed:",(error as any)?.code||"TRENDING_UNKNOWN_ERROR",error instanceof Error?error.message:"unknown");}
  if(!pool.length)throw providerError("NO_VALID_TRAILER","No valid movie trailers are available right now.");
  return pool;
}
async function getPool(cfg:TrendingConfig,forceRefresh=false){
  const cached=cacheState.get(cacheKey);
  if(!forceRefresh&&cached?.value.length)return cached.value;
  const running=refreshState.get(cacheKey);if(running)return running;
  const promise=fetchTrending(cfg).then(value=>{cacheState.set(cacheKey,{expiresAt:Date.now()+cfg.cacheTtlMs,value});return value;}).finally(()=>refreshState.delete(cacheKey));
  refreshState.set(cacheKey,promise);return promise;
}
function choose(pool:TrendingVideo[],clientId:string,cfg:TrendingConfig){
  const recent=recentState.get(clientId)||[];const available=pool.filter(v=>!recent.includes(v.videoId));const candidates=available.length?available:pool;
  const picked=candidates[Math.floor(Math.random()*candidates.length)];if(!picked)throw new Error("No valid movie trailers are available right now.");
  recentState.set(clientId,[picked.videoId,...recent.filter(id=>id!==picked.videoId)].slice(0,cfg.recentHistorySize));return picked;
}
export async function getTrendingVideoForClient(clientId:string){
  const cfg=await config();if(!cfg.enabled)throw new Error("Trending movie trailer tasks are temporarily unavailable.");
  const cached=cacheState.get(cacheKey);
  if(cached?.value.length){
    if(cached.expiresAt<=Date.now())void getPool(cfg,true).catch(error=>console.error("[trending] background refresh failed:",error instanceof Error?error.message:"unknown"));
    return choose(cached.value,clientId,cfg);
  }
  const stored=await prisma.task.findMany({
    where:{videoId:{not:null}},
    orderBy:{revealedAt:"desc"},
    take:50,
    select:{videoProvider:true,videoId:true,videoTitle:true,videoChannelId:true,videoChannelTitle:true,videoThumbnailUrl:true,videoDurationSeconds:true,videoPublishedAt:true,videoCategoryId:true,videoViewCount:true,videoLikeCount:true,videoCommentCount:true,videoLiveBroadcastContent:true}
  });
  const storedPool:TrendingVideo[]=stored.filter(v=>v.videoId).map(v=>({
    provider:"youtube",videoId:String(v.videoId),title:String(v.videoTitle||"Movie Trailer"),channelId:String(v.videoChannelId||""),channelTitle:String(v.videoChannelTitle||""),
    thumbnailUrl:String(v.videoThumbnailUrl||""),durationSeconds:Number(v.videoDurationSeconds||0),publishedAt:v.videoPublishedAt?.toISOString()||"",
    categoryId:String(v.videoCategoryId||""),description:"",viewCount:Number(v.videoViewCount||0),likeCount:Number(v.videoLikeCount||0),
    commentCount:Number(v.videoCommentCount||0),liveBroadcastContent:String(v.videoLiveBroadcastContent||"none")
  }));
  if(storedPool.length){
    const pool=dedupeAndRank(storedPool,cfg);cacheState.set(cacheKey,{expiresAt:Date.now()+cfg.cacheTtlMs,value:pool});
    void getPool(cfg,true).catch(error=>console.error("[trending] background refresh failed:",error instanceof Error?error.message:"unknown"));
    return choose(pool,clientId,cfg);
  }
  try{
    const refreshed=await getPool(cfg,true);
    return choose(refreshed,clientId,cfg);
  }catch(error){
    console.error("[trending] controlled empty-cache refresh failed:",(error as any)?.code||"TRENDING_UNKNOWN_ERROR",error instanceof Error?error.message:"unknown");
    throw error;
  }
}
export async function warmTrendingVideoCache(){const cfg=await config();if(!cfg.enabled)return {enabled:false,count:0,expiresAt:null};const value=await getPool(cfg,false);const cached=cacheState.get(cacheKey);return {enabled:true,count:value.length,expiresAt:cached?.expiresAt??null};}
export async function refreshTrendingVideoCache(){const cfg=await config();if(!cfg.enabled)return {enabled:false,count:0,expiresAt:null};const value=await getPool(cfg,true);const cached=cacheState.get(cacheKey);return {enabled:true,count:value.length,expiresAt:cached?.expiresAt??null};}
export async function trendingConfig(){
  const cfg=await config();
  return {enabled:cfg.enabled,provider:"YouTube",regionCode:cfg.regionCode,categoryId:cfg.categoryId,cacheTtlMinutes:cfg.cacheTtlMs/60_000,poolSize:cfg.poolSize,recentHistorySize:cfg.recentHistorySize,minimumDurationSeconds:cfg.minDurationSeconds,maximumDurationSeconds:cfg.maxDurationSeconds,freshnessDays:cfg.freshnessDays,discoveryQueries:cfg.discoveryQueries};
}
