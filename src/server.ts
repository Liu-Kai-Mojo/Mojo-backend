import "dotenv/config";
import express from "express";
import cors from "cors";
import { execFile, type ChildProcess } from "node:child_process";
import { Role, IdentifierType, MessageStatus, TaskStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma.js";
import { auth, hashPassword, verifyPassword, issueToken } from "./auth.js";
import { registerSchema, loginSchema, movieSchema, messageSchema, taskSchema } from "./validation.js";
import { uniqueUserId, uniqueMovieId, uniqueHistoryId, uniqueMessageId, uniqueSettingId, uniqueWalletTransactionId, uniqueTaskId, uniqueInviteCode, uniqueAuditLogId } from "./utils/codes.js";
import { getTrendingVideoForClient, trendingConfig } from "./trending.js";

const app=express();
app.set("trust proxy",1);
const port=Number(process.env.PORT||8787);
const isProduction=process.env.NODE_ENV==="production";
const normalize=(v:string)=>v.trim().replace(/\/+$/g,"");
const defaults=["https://box-office-mojo.pages.dev","https://mojo-client.pages.dev","https://mojo-admin.pages.dev","https://mojo-administrator.pages.dev","https://mojo-owner.pages.dev"];
const origins=Array.from(new Set([...defaults,...(process.env.FRONTEND_ORIGINS||"").split(",").map(normalize).filter(Boolean)]));
if(!isProduction) origins.push("http://localhost:5173","http://127.0.0.1:5173");
app.disable("x-powered-by");
app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");res.setHeader("Content-Security-Policy","default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");res.setHeader("Cross-Origin-Resource-Policy","same-site");if(isProduction)res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");next();});
app.use(cors({origin(origin,cb){if(!origin||origins.includes(normalize(origin)))return cb(null,true);return cb(new Error("Origin is not allowed by CORS."));},credentials:true,methods:["GET","POST","PATCH","DELETE","OPTIONS"],allowedHeaders:["Content-Type","Authorization"]}));
app.use(express.json({limit:"2mb"}));

// Lightweight in-process rate limiting. This intentionally protects only sensitive API classes;
// normal authenticated reads remain unrestricted. For multi-replica deployments, an upstream
// gateway/rate-limit service should be used as the shared enforcement layer.
type RateBucket={count:number;resetAt:number};
const rateBuckets=new Map<string,RateBucket>();
const rateLimit=(name:string,limit:number,windowMs:number)=>(req:express.Request,res:express.Response,next:express.NextFunction)=>{
  const key=name+":"+String(req.ip||req.socket.remoteAddress||"unknown");
  const now=Date.now();
  const current=rateBuckets.get(key);
  if(!current||current.resetAt<=now){rateBuckets.set(key,{count:1,resetAt:now+windowMs});return next();}
  current.count+=1;
  if(current.count>limit){res.setHeader("Retry-After",Math.ceil((current.resetAt-now)/1000));return res.status(429).json({error:"Too many requests. Please try again later.",code:"RATE_LIMITED"});}
  return next();
};
const cleanupRateBuckets=()=>{const now=Date.now();for(const [key,bucket] of rateBuckets){if(bucket.resetAt<=now)rateBuckets.delete(key);}};
const rateCleanup=setInterval(cleanupRateBuckets,60_000);rateCleanup.unref();

app.post("/api/auth/login",rateLimit("login",10,60_000));
app.post("/api/auth/register",rateLimit("register",5,15*60_000));
app.post("/api/client/messages",rateLimit("client-message",30,60_000));
app.post("/api/admin/messages",rateLimit("admin-message",60,60_000));
app.patch("/api/admin/messages",rateLimit("admin-message-status",60,60_000));
app.patch("/api/admin/balances",rateLimit("admin-balance",60,60_000));
app.post("/api/admin/balances",rateLimit("admin-balance",60,60_000));


app.use((req,res,next)=>{if(req.path.startsWith("/api/"))res.setHeader("Cache-Control","no-store");next();});

function detectIdentifier(v:string){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)?IdentifierType.EMAIL:IdentifierType.PHONE;}
function safeUser(u:any){return {id:u.id,name:u.name,identifier:u.identifier,identifierType:u.identifierType,role:u.role,active:u.active,adminId:u.adminId??null,balanceCents:u.balanceCents??0,frozenCents:u.frozenCents??0,creditScore:u.creditScore??1000,welcomeBonusGrantedAt:u.welcomeBonusGrantedAt??null,createdAt:u.createdAt,...(u.role===Role.ADMIN?{inviteCode:u.inviteCode??null}:{})};}
async function audit(actorId:string|undefined, targetId:string|undefined, action:string, details?:unknown){
  await prisma.auditLog.create({
    data:{
      id:await uniqueAuditLogId(),
      actorId:actorId||null,
      targetId:targetId||null,
      action,
      details:details===undefined?null:JSON.stringify(details)
    }
  });
}
async function ensureOwnerFromEnv(){
  const identifierRaw=(process.env.OWNER_EMAIL||process.env.OWNER_IDENTIFIER)?.trim();
  const password=process.env.OWNER_PASSWORD?.trim();
  if(!identifierRaw||!password)return;
  const identifier=identifierRaw.includes("@")?identifierRaw.toLowerCase():identifierRaw;
  const passwordHash=await hashPassword(password);
  const existing=await prisma.user.findUnique({where:{identifier}});
  if(existing){
    if(existing.role!==Role.OWNER || !existing.active || !(await verifyPassword(password,existing.passwordHash))){
      await prisma.user.update({where:{id:existing.id},data:{name:"Studio Owner",passwordHash,role:Role.OWNER,active:true}});
    }
    return;
  }
  await prisma.user.create({data:{id:await uniqueUserId(),name:"Studio Owner",identifier,identifierType:detectIdentifier(identifier),passwordHash,role:Role.OWNER,active:true}});
}

function param(req:express.Request,k:string){const v=req.params[k];return Array.isArray(v)?v[0]||"":v||"";}
function asyncRoute(fn:(req:express.Request,res:express.Response,next:express.NextFunction)=>unknown|Promise<unknown>):express.RequestHandler{return(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
function money(c:number){return Math.max(0,Math.round(c));}
function defaultTaskAmount(balanceCents:number,sequence:number){const tiers=balanceCents<500?500:balanceCents<2000?1000:balanceCents<10000?2500:5000;return tiers+Math.min(sequence-1,4)*Math.round(tiers*.2);}
function defaultCommission(amount:number){return Math.max(1,Math.round(amount*.05));}
function randomTaskAmount(balanceCents:number,sequence:number){const minimum=5000;if(balanceCents<minimum)return minimum;const max=Math.max(minimum,Math.min(balanceCents,Math.max(minimum,Math.floor(balanceCents*(0.18+Math.random()*0.18)))));const step=Math.max(100,Math.round((max-minimum)/5));const choices=[minimum,minimum+step,minimum+step*2,minimum+step*3,max].filter(v=>v<=balanceCents);return choices[Math.floor(Math.random()*choices.length)]||minimum}
async function ensureTaskBatch(clientId:string,assignedById?:string){
  const count=await prisma.task.count({where:{clientId}});
  if(count>=30)return;
  await prisma.$transaction(async tx=>{for(let i=count+1;i<=30;i++){await tx.task.create({data:{id:await uniqueTaskId(),clientId,assignedById,sequence:i,title:i===2?"Lucky combination":"Daily task",amountCents:0,commissionCents:0,isLucky:i===2}});}});
}
async function fetchMovieFeed(){
  const titles=["Resident Evil","Practical Magic 2","Spider-Man: Brand New Day","The Odyssey","Coyote vs. Acme","Runner","Daniel and the Fiery Furnace","The Transformers: The Movie","The Weight","Buddy","Insidious: Out of the Further","PAW Patrol: The Dino Movie","Toy Story 5","Moana","Obsession","Avengers: Secret Wars","Super Mario Galaxy Movie","The Hunger Games: Sunrise on the Reaping"];
  const key=process.env.TMDB_API_KEY||process.env.TMDB_API||"";
  const token=process.env.TMDB_API_READ_TOKEN||"";
  const out:any[]=[];
  for(const title of titles){
    let hit:any=null;
    let posterUrl="";
    let trailerUrl="";
    if(key||token){
      try{
        const base="https://api.themoviedb.org/3/search/movie?query="+encodeURIComponent(title)+"&include_adult=false&language=en-US&page=1";
        const url=token?base:base+"&api_key="+encodeURIComponent(key);
        const rr=await fetch(url,{headers:token?{Authorization:"Bearer "+token}:{"accept":"application/json"}});
        const jj:any=await rr.json();
        hit=jj.results?.[0]||null;
        if(hit?.poster_path)posterUrl="https://image.tmdb.org/t/p/w780"+hit.poster_path;
        if(hit?.id){
          const detailBase="https://api.themoviedb.org/3/movie/"+hit.id+"/videos?language=en-US";
          const detailUrl=token?detailBase:detailBase+"&api_key="+encodeURIComponent(key);
          const vr=await fetch(detailUrl,{headers:token?{Authorization:"Bearer "+token}:{"accept":"application/json"}});
          const vj:any=await vr.json();
          const trailer=vj.results?.find((v:any)=>v.site==="YouTube"&&(v.type==="Trailer"||v.type==="Teaser")&&v.official!==false)||vj.results?.find((v:any)=>v.site==="YouTube");
          if(trailer?.key)trailerUrl="https://www.youtube.com/embed/"+trailer.key+"?autoplay=1&rel=0&modestbranding=1";
        }
      }catch{}
    }
    const popularity=Number(hit?.popularity||10);
    const priceCents=Math.max(500,Math.round(popularity*100));
    out.push({title,tmdbId:hit?.id??null,posterUrl,priceCents,trailerUrl});
  }
  return out;
}
function taskPublic(t:any,includeValues=false){
  return {
    id:t.id,sequence:t.sequence,title:t.title,status:t.status,isLucky:t.isLucky,createdAt:t.createdAt,
    revealedAt:t.revealedAt,completedAt:t.completedAt,rating:t.rating??null,
    requiredWatchSeconds:t.requiredWatchSeconds??0,
    video:t.videoId?{
      provider:t.videoProvider||"youtube",videoId:t.videoId,title:t.videoTitle||t.title,
      channelTitle:t.videoChannelTitle||"",thumbnailUrl:t.videoThumbnailUrl||"",
      durationSeconds:t.videoDurationSeconds??0,publishedAt:t.videoPublishedAt,categoryId:t.videoCategoryId||""
    }:null,
    ...(includeValues?{amountCents:t.amountCents,commissionCents:t.commissionCents}: {})
  };
}
function staffWhere(role:Role,id:string){return role===Role.OWNER?{role:Role.CLIENT}:{role:Role.CLIENT,adminId:id};}
function canManageClient(role:Role,id:string,clientId:string){return prisma.user.findFirst({where:{id:clientId,role:Role.CLIENT,...(role===Role.ADMIN?{adminId:id}:{})}});}

let applicationReady=false;let migrationProcess:ChildProcess|null=null;
app.get("/",(_req,res)=>res.json({ok:true,service:"box-office-mojo-api",status:"alive",time:new Date().toISOString()}));
app.get("/health",(_req,res)=>res.json({ok:true,service:"box-office-mojo-api",status:"alive",time:new Date().toISOString()}));
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"box-office-mojo-api",status:"alive",time:new Date().toISOString()}));
app.get("/ready",async(_req,res)=>{if(!applicationReady)return res.status(503).json({ok:false,status:"starting",database:"not-ready"});try{await prisma.$queryRaw`SELECT 1`;return res.json({ok:true,status:"ready",database:"ok"});}catch{return res.status(503).json({ok:false,status:"not-ready",database:"unavailable"});}});
app.get("/api/ready",async(_req,res)=>{if(!applicationReady)return res.status(503).json({ok:false,status:"starting",database:"not-ready"});try{await prisma.$queryRaw`SELECT 1`;return res.json({ok:true,status:"ready",database:"ok"});}catch{return res.status(503).json({ok:false,status:"not-ready",database:"unavailable"});}});
app.use((req,res,next)=>{if(!req.path.startsWith("/api/")||req.path.endsWith("/health")||req.path.endsWith("/ready"))return next();if(applicationReady)return next();const authPath=["/api/auth/login","/api/auth/register"].includes(req.path);if(authPath)return prisma.$queryRaw`SELECT 1`.then(()=>next()).catch(()=>res.status(503).json({error:"The service is still connecting to its database.",code:"DATABASE_STARTING"}));return res.status(503).json({error:"The service is getting ready. Please try again in a moment.",code:"SERVICE_STARTING"});});

app.post("/api/auth/register",asyncRoute(async(req,res)=>{
  const d=registerSchema.parse(req.body);const identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;
  if(await prisma.user.findUnique({where:{identifier}}))return res.status(409).json({error:"That email or phone number is already in use."});
  const admin=await prisma.user.findUnique({where:{inviteCode:d.inviteCode},select:{id:true,role:true,active:true}});
  if(!admin||admin.role!==Role.ADMIN||!admin.active)return res.status(400).json({error:"That invite code is unavailable. Please ask your administrator for an active invite code."});
  const user=await prisma.$transaction(async tx=>{const u=await tx.user.create({data:{id:await uniqueUserId(),name:d.name,identifier,identifierType:detectIdentifier(identifier),passwordHash:await hashPassword(d.password),withdrawalPasswordHash:await hashPassword(d.withdrawalPassword),role:Role.CLIENT,adminId:admin.id,balanceCents:1000,welcomeBonusGrantedAt:new Date()}});await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:u.id,amountCents:1000,type:"WELCOME_BONUS",note:"Welcome balance"}});return u;});
  await audit(undefined,user.id,"CLIENT_REGISTERED",{adminId:admin.id}); const token=issueToken({id:user.id,role:user.role});return res.status(201).json({token,user:safeUser(user),message:"Your account is ready. Your welcome balance has been added."});
}));
app.post("/api/auth/login",asyncRoute(async(req,res)=>{const d=loginSchema.parse(req.body);const identifier=d.identifier.trim().includes("@")?d.identifier.trim().toLowerCase():d.identifier.trim();const user=await prisma.user.findUnique({where:{identifier}});if(!user)return res.status(401).json({error:"We could not find an account with that email or phone number."});if(!user.active)return res.status(403).json({error:"This account is currently paused. Please contact the workspace owner."});if(!(await verifyPassword(d.password,user.passwordHash)))return res.status(401).json({error:"The password does not match this account."});const token=issueToken({id:user.id,role:user.role});return res.json({token,user:safeUser(user),message:"Welcome back."});}));
app.get("/api/me",auth(),asyncRoute(async(_req,res)=>{const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});res.json({user:safeUser(u)});}));

const SYSTEM_STATUS_KEY="system_status";
async function readSystemEnabled(){const setting=await prisma.setting.findUnique({where:{key:SYSTEM_STATUS_KEY}});return setting?setting.value!=="false":true;}
app.get("/api/system/status",auth([Role.OWNER,Role.ADMIN]),asyncRoute(async(_req,res)=>{res.json({enabled:await readSystemEnabled(),source:"backend"});}));
app.patch("/api/system/status",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const d=z.object({enabled:z.boolean()}).parse(req.body);const setting=await prisma.setting.upsert({where:{key:SYSTEM_STATUS_KEY},create:{id:await uniqueSettingId(),key:SYSTEM_STATUS_KEY,value:String(d.enabled)},update:{value:String(d.enabled)}});await audit(res.locals.auth.sub,undefined,"SYSTEM_STATUS_CHANGED",{enabled:d.enabled});res.json({enabled:setting.value!=="false",source:"backend"});}));

// A logical platform-off state never shuts down the process. Owner/Admin access remains available,
// while Client business operations are paused until the Owner re-enables the platform.
const platformGuard:express.RequestHandler=async(_req,res,next)=>{try{if(await readSystemEnabled())return next();return res.status(503).json({error:"The platform is temporarily unavailable. Please try again later.",code:"PLATFORM_OFF"});}catch(error){return next(error);}};
const clientAuth=()=>[auth([Role.CLIENT]),platformGuard] as express.RequestHandler[];

app.get("/api/client/support",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{
  const client=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub},select:{adminId:true}});
  const admin=client.adminId?await prisma.user.findFirst({where:{id:client.adminId,role:Role.ADMIN,active:true},select:{id:true,name:true}}):null;
  const setting=admin?await prisma.setting.findUnique({where:{key:`telegram_admin_${admin.id}`}}):null;
  res.json({admin:admin?{id:admin.id,name:admin.name}:null,telegramUsername:setting?.value||null});
}));
app.get("/api/client/movies",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{const cache=(globalThis as any).__tmdbMovieFeedCache as {expires:number;value:any[]}|undefined;const pending=(globalThis as any).__tmdbMovieFeedPending as Promise<any[]>|undefined;if(cache&&cache.expires>Date.now())return res.json({movies:cache.value});const promise=pending||fetchMovieFeed();(globalThis as any).__tmdbMovieFeedPending=promise;try{const movies=await promise;(globalThis as any).__tmdbMovieFeedCache={expires:Date.now()+10*60*1000,value:movies};res.json({movies});}finally{if((globalThis as any).__tmdbMovieFeedPending===promise)(globalThis as any).__tmdbMovieFeedPending=undefined}}));
app.get("/api/client/movies/:id/videos",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{const id=Number(param(req,"id"));if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:"Invalid movie id."});const token=process.env.TMDB_API_READ_TOKEN||"";const key=process.env.TMDB_API_KEY||process.env.TMDB_API||"";if(!token&&!key)return res.status(503).json({error:"Movie video service is not configured.",code:"TMDB_NOT_CONFIGURED"});const cache=(globalThis as any).__tmdbVideoCache as Map<number,{expires:number;value:any}>|undefined;const videoCache=cache||new Map<number,{expires:number;value:any}>();(globalThis as any).__tmdbVideoCache=videoCache;const hit=videoCache.get(id);if(hit&&hit.expires>Date.now())return res.json(hit.value);try{const base=`https://api.themoviedb.org/3/movie/${id}?append_to_response=videos&language=en-US`;const url=token?base:base+`&api_key=${encodeURIComponent(key)}`;const rr=await fetch(url,{headers:token?{Authorization:`Bearer ${token}`}:{accept:"application/json"},signal:AbortSignal.timeout(8000)});if(!rr.ok){if(rr.status===404)return res.status(404).json({error:"Movie not found."});if(rr.status===429)return res.status(429).json({error:"Movie video service is temporarily busy.",code:"TMDB_RATE_LIMIT"});return res.status(502).json({error:"Movie video service is unavailable.",code:"TMDB_UPSTREAM_ERROR"});}const movie:any=await rr.json();const videos=Array.isArray(movie.videos?.results)?movie.videos.results:[];const selected=videos.find((v:any)=>v.site==="YouTube"&&v.type==="Trailer"&&v.official!==false)||videos.find((v:any)=>v.site==="YouTube"&&v.type==="Teaser"&&v.official!==false)||videos.find((v:any)=>v.site==="YouTube"&&(v.type==="Trailer"||v.type==="Teaser"));const value={movieId:id,title:movie.title||"",video:selected?{key:selected.key,name:selected.name,type:selected.type,site:selected.site,embedUrl:`https://www.youtube.com/embed/${selected.key}?autoplay=1&rel=0&modestbranding=1`}:null};videoCache.set(id,{expires:Date.now()+10*60*1000,value});res.json(value);}catch{res.status(502).json({error:"Movie video service is unavailable.",code:"TMDB_NETWORK_ERROR"});}}));
app.get("/api/client/home",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{const userId=res.locals.auth.sub;await ensureTaskBatch(userId);const [u,tasks,txs,messages]=await Promise.all([prisma.user.findUniqueOrThrow({where:{id:userId}}),prisma.task.findMany({where:{clientId:userId},orderBy:{sequence:"asc"}}),prisma.walletTransaction.findMany({where:{userId},orderBy:{createdAt:"desc"},take:8}),prisma.message.findMany({where:{OR:[{senderId:userId},{recipientId:userId}]},orderBy:{createdAt:"desc"},take:6})]);res.json({user:safeUser(u),tasks:tasks.map(t=>taskPublic(t,false)),transactions:txs,messages});}));
app.get("/api/client/wallet",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});const transactions=await prisma.walletTransaction.findMany({where:{userId:u.id},orderBy:{createdAt:"desc"},take:50});res.json({user:safeUser(u),transactions});}));
app.get("/api/client/tasks",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{const clientId=res.locals.auth.sub;await ensureTaskBatch(clientId);const tasks=await prisma.task.findMany({where:{clientId},orderBy:{sequence:"asc"}});const current=tasks.find(t=>t.status===TaskStatus.PENDING)||null;res.json({tasks:tasks.map(t=>taskPublic(t,false)),current:current?taskPublic(current,false):null,completed:tasks.filter(t=>t.status===TaskStatus.COMPLETED).length,total:tasks.length});}));
app.post("/api/client/tasks/:id/reveal",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const clientId=res.locals.auth.sub;
  const [task,user]=await Promise.all([
    prisma.task.findFirst({where:{id,clientId}}),
    prisma.user.findUniqueOrThrow({where:{id:clientId},select:{balanceCents:true}})
  ]);
  if(!task)return res.status(404).json({error:"Task not found."});
  const first=await prisma.task.findFirst({where:{clientId,status:TaskStatus.PENDING},orderBy:{sequence:"asc"}});
  if(!first||first.id!==task.id)return res.status(409).json({error:"Please finish your current task before opening another one."});
  let updated=task;
  if(!task.revealedAt){
    const amount=randomTaskAmount(user.balanceCents,task.sequence);
    if(user.balanceCents<amount)return res.status(409).json({error:"Your available balance is not enough for this task. Please add funds before starting the next task."});
    try{
      const video=await getTrendingVideoForClient(clientId);
      updated=await prisma.task.update({where:{id},data:{
        amountCents:amount,commissionCents:defaultCommission(amount),revealedAt:new Date(),
        videoProvider:video.provider,videoId:video.videoId,videoTitle:video.title,videoChannelTitle:video.channelTitle,
        videoThumbnailUrl:video.thumbnailUrl,videoDurationSeconds:video.durationSeconds,
        videoPublishedAt:video.publishedAt?new Date(video.publishedAt):null,videoCategoryId:video.categoryId
      }});
    }catch(error){
      const message=error instanceof Error?error.message:"Trending videos are temporarily unavailable.";
      return res.status(503).json({error:message,code:"TRENDING_VIDEO_UNAVAILABLE"});
    }
  }else if(task.amountCents>user.balanceCents){
    return res.status(409).json({error:"Your available balance is not enough for this task. Please add funds before continuing."});
  }else if(!task.videoId){
    try{
      const video=await getTrendingVideoForClient(clientId);
      updated=await prisma.task.update({where:{id},data:{
        videoProvider:video.provider,videoId:video.videoId,videoTitle:video.title,videoChannelTitle:video.channelTitle,
        videoThumbnailUrl:video.thumbnailUrl,videoDurationSeconds:video.durationSeconds,
        videoPublishedAt:video.publishedAt?new Date(video.publishedAt):null,videoCategoryId:video.categoryId
      }});
    }catch{return res.status(503).json({error:"This video isn't available right now. We're loading another one.",code:"TRENDING_VIDEO_UNAVAILABLE"});}
  }
  res.json({task:taskPublic(updated,true)});
}));
app.post("/api/client/tasks/:id/video-retry",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const clientId=res.locals.auth.sub;
  const task=await prisma.task.findFirst({where:{id,clientId,status:TaskStatus.PENDING}});
  if(!task)return res.status(404).json({error:"Task not found."});
  if(!task.revealedAt)return res.status(400).json({error:"Open the task details first."});
  try{
    const video=await getTrendingVideoForClient(clientId);
    const updated=await prisma.task.update({where:{id},data:{
      videoProvider:video.provider,videoId:video.videoId,videoTitle:video.title,videoChannelTitle:video.channelTitle,
      videoThumbnailUrl:video.thumbnailUrl,videoDurationSeconds:video.durationSeconds,
      videoPublishedAt:video.publishedAt?new Date(video.publishedAt):null,videoCategoryId:video.categoryId
    }});
    res.json({task:taskPublic(updated,true)});
  }catch{return res.status(503).json({error:"This video isn't available right now. We're loading another one.",code:"TRENDING_VIDEO_UNAVAILABLE"});}
}));
app.post("/api/client/tasks/:id/complete",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const clientId=res.locals.auth.sub;
  const d=z.object({rating:z.coerce.number().int().min(1).max(5).nullable().optional()}).parse(req.body||{});
  const task=await prisma.task.findFirst({where:{id,clientId}});
  if(!task)return res.status(404).json({error:"Task not found."});
  const first=await prisma.task.findFirst({where:{clientId,status:TaskStatus.PENDING},orderBy:{sequence:"asc"}});
  if(!first||first.id!==task.id)return res.status(409).json({error:"Please finish your current task before continuing."});
  if(!task.revealedAt)return res.status(400).json({error:"Open the task details first."});
  if(!task.videoId)return res.status(400).json({error:"A valid video has not been assigned to this task yet."});
  const result=await prisma.$transaction(async tx=>{
    const fresh=await tx.task.findUniqueOrThrow({where:{id}});
    if(fresh.status!==TaskStatus.PENDING)throw new Error("This task has already been completed.");
    const before=await tx.user.findUniqueOrThrow({where:{id:clientId},select:{balanceCents:true}});
    if(before.balanceCents<fresh.amountCents)throw new Error("Your available balance is not enough for this task. Please add funds before finishing it.");
    const user=await tx.user.update({where:{id:clientId},data:{balanceCents:{increment:fresh.commissionCents}}});
    const completed=await tx.task.update({where:{id},data:{status:TaskStatus.COMPLETED,completedAt:new Date(),rating:d.rating??fresh.rating}});
    await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:clientId,amountCents:fresh.commissionCents,type:"TASK_COMMISSION",note:`Task #${fresh.sequence} commission` }});
    return {user,task:completed};
  });
  res.json({user:safeUser(result.user),task:taskPublic(result.task,true),message:"Task completed and your balance has been updated."});
}));
app.get("/api/client/messages",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{const messages=await prisma.message.findMany({where:{OR:[{senderId:res.locals.auth.sub},{recipientId:res.locals.auth.sub}]},orderBy:{createdAt:"asc"}});res.json({messages});}));
app.post("/api/client/messages",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{const d=messageSchema.parse(req.body);const sender=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub},select:{adminId:true}});const recipient=d.recipientId?await prisma.user.findFirst({where:{id:d.recipientId,role:{in:[Role.ADMIN,Role.OWNER]},active:true}}):sender.adminId?await prisma.user.findFirst({where:{id:sender.adminId,role:Role.ADMIN,active:true}}):null;if(!recipient)return res.status(400).json({error:"Your account is not currently connected to an active administrator."});const msg=await prisma.message.create({data:{id:await uniqueMessageId(),senderId:res.locals.auth.sub,recipientId:recipient.id,subject:d.subject,body:d.body}});res.status(201).json({message:msg});}));
app.get("/api/client/account",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{
  const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});
  const wallet=await prisma.setting.findUnique({where:{key:`wallet_client_${u.id}`}});
  res.json({user:safeUser(u),walletAddress:wallet?.value||""});
}));
app.patch("/api/client/account/password",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const d=z.object({currentPassword:z.string().min(1).max(100),newPassword:z.string().min(6).max(100)}).parse(req.body);
  const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});
  if(!(await verifyPassword(d.currentPassword,u.passwordHash)))return res.status(400).json({error:"Your current password is not correct."});
  await prisma.user.update({where:{id:u.id},data:{passwordHash:await hashPassword(d.newPassword)}});
  await audit(u.id,u.id,"CLIENT_LOGIN_PASSWORD_CHANGED");
  res.json({message:"Login password updated successfully."});
}));
app.patch("/api/client/account/withdrawal-password",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const d=z.object({currentPassword:z.string().min(1).max(100),newPassword:z.string().min(6).max(100)}).parse(req.body);
  const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});
  if(!u.withdrawalPasswordHash||!(await verifyPassword(d.currentPassword,u.withdrawalPasswordHash)))return res.status(400).json({error:"Your current withdrawal password is not correct."});
  await prisma.user.update({where:{id:u.id},data:{withdrawalPasswordHash:await hashPassword(d.newPassword)}});
  await audit(u.id,u.id,"CLIENT_WITHDRAWAL_PASSWORD_CHANGED");
  res.json({message:"Withdrawal password updated successfully."});
}));
app.patch("/api/client/account/wallet",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const d=z.object({address:z.string().trim().min(3).max(160)}).parse(req.body);
  const key=`wallet_client_${res.locals.auth.sub}`;
  const setting=await prisma.setting.upsert({where:{key},create:{id:await uniqueSettingId(),key,value:d.address},update:{value:d.address}});
  await audit(res.locals.auth.sub,res.locals.auth.sub,"CLIENT_WALLET_UPDATED");
  res.json({walletAddress:setting.value,message:"Wallet address saved successfully."});
}));

const staff=[Role.OWNER,Role.ADMIN];
app.get("/api/admin/trending-config",auth(staff),asyncRoute(async(_req,res)=>{res.json({config:await trendingConfig()});}));
app.patch("/api/admin/trending-config",auth(staff),asyncRoute(async(req,res)=>{
  const d=z.object({
    enabled:z.boolean().optional(),regionCode:z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),categoryId:z.string().trim().min(1).max(10).optional(),
    cacheTtlMinutes:z.coerce.number().int().min(1).max(1440).optional(),poolSize:z.coerce.number().int().min(5).max(50).optional(),
    recentHistorySize:z.coerce.number().int().min(1).max(50).optional(),minimumDurationSeconds:z.coerce.number().int().min(0).max(86400).optional(),
    maximumDurationSeconds:z.coerce.number().int().min(0).max(86400).optional()
  }).parse(req.body||{});
  const map:any={enabled:"trending_videos_enabled",regionCode:"trending_region_code",categoryId:"trending_category_id",cacheTtlMinutes:"trending_cache_ttl_minutes",poolSize:"trending_pool_size",recentHistorySize:"trending_recent_history_size",minimumDurationSeconds:"trending_min_duration_seconds",maximumDurationSeconds:"trending_max_duration_seconds"};
  for(const [field,key] of Object.entries(map))if((d as any)[field]!==undefined)await prisma.setting.upsert({where:{key},create:{id:await uniqueSettingId(),key,value:String((d as any)[field])},update:{value:String((d as any)[field])}});
  await audit(res.locals.auth.sub,undefined,"TRENDING_CONFIG_UPDATED",{fields:Object.keys(d)});
  res.json({config:await trendingConfig(),message:"Trending video settings saved."});
}));
app.get("/api/admin/dashboard",auth(staff),asyncRoute(async(_req,res)=>{const role=res.locals.auth.role;const where=staffWhere(role,res.locals.auth.sub);const [clients,admins,messages,pendingTasks,completedTasks]=await Promise.all([prisma.user.count({where:{...where,active:true}}),prisma.user.count({where:{role:Role.ADMIN,active:true}}),prisma.message.count({where:role===Role.OWNER?{status:{in:[MessageStatus.OPEN,MessageStatus.REPLIED]}}:{status:{in:[MessageStatus.OPEN,MessageStatus.REPLIED]},OR:[{recipientId:res.locals.auth.sub},{sender:{adminId:res.locals.auth.sub}}]}}),prisma.task.count({where:{status:TaskStatus.PENDING,...(role===Role.ADMIN?{client:{adminId:res.locals.auth.sub}}:{})}}),prisma.task.count({where:{status:TaskStatus.COMPLETED,...(role===Role.ADMIN?{client:{adminId:res.locals.auth.sub}}:{})}})]);res.json({clients,admins,messages,pendingTasks,completedTasks});}));
app.get("/api/admin/clients",auth(staff),asyncRoute(async(_req,res)=>{const role=res.locals.auth.role;const clients=await prisma.user.findMany({where:staffWhere(role,res.locals.auth.sub),orderBy:{createdAt:"desc"}});res.json({clients:clients.map(safeUser)});}));
app.get("/api/admin/balances",auth([Role.ADMIN]),asyncRoute(async(_req,res)=>{
  const clients=await prisma.user.findMany({where:{role:Role.CLIENT,adminId:res.locals.auth.sub},orderBy:{createdAt:"desc"}});
  res.json({balances:clients.map(u=>({...safeUser(u),availableCents:Math.max(0,u.balanceCents-(u.frozenCents??0))}))});
}));

app.patch("/api/admin/balances/:id",auth([Role.ADMIN]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const d=z.object({frozenCents:z.coerce.number().int().min(0).max(100000000).optional(),creditScore:z.coerce.number().int().min(0).max(10000).optional()}).refine(v=>v.frozenCents!==undefined||v.creditScore!==undefined,{message:"Please provide a balance control value."}).parse(req.body||{});
  const current=await prisma.user.findFirst({where:{id,role:Role.CLIENT,adminId:res.locals.auth.sub}});
  if(!current)return res.status(404).json({error:"Client not found in your workspace."});
  if(d.frozenCents!==undefined&&d.frozenCents>current.balanceCents)return res.status(400).json({error:"Frozen amount cannot be greater than the current account balance."});
  const u=await prisma.user.update({where:{id},data:{...(d.frozenCents!==undefined?{frozenCents:d.frozenCents}:{}),...(d.creditScore!==undefined?{creditScore:d.creditScore}:{})}});
  await audit(res.locals.auth.sub,id,"CLIENT_BALANCE_CONTROL_UPDATED",{fields:Object.keys(d)});
  res.json({balance:{...safeUser(u),availableCents:Math.max(0,u.balanceCents-(u.frozenCents??0))},message:"Balance controls updated."});
}));

app.post("/api/admin/balances/:id/adjust",auth([Role.ADMIN]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const d=z.object({type:z.enum(["CREDIT","DEBIT"]),amountCents:z.coerce.number().int().positive().max(100000000),note:z.string().trim().max(300).optional()}).parse(req.body||{});
  const current=await prisma.user.findFirst({where:{id,role:Role.CLIENT,adminId:res.locals.auth.sub}});
  if(!current)return res.status(404).json({error:"Client not found in your workspace."});
  const delta=d.type==="CREDIT"?d.amountCents:-d.amountCents;
  if(delta<0&&current.balanceCents<d.amountCents)return res.status(400).json({error:"Debit amount cannot be greater than the current account balance."});
  const result=await prisma.$transaction(async tx=>{
    await tx.user.update({where:{id},data:{balanceCents:{increment:delta}}});
    const after=await tx.user.findUniqueOrThrow({where:{id}});
    if((after.frozenCents??0)>after.balanceCents)await tx.user.update({where:{id},data:{frozenCents:after.balanceCents}});
    const final=await tx.user.findUniqueOrThrow({where:{id}});
    await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:id,amountCents:delta,type:d.type==="CREDIT"?"ADMIN_CREDIT":"ADMIN_DEBIT",note:d.note||(d.type==="CREDIT"?"Balance credit by administrator":"Balance debit by administrator")}});
    return final;
  });
  await audit(res.locals.auth.sub,id,"CLIENT_BALANCE_ADJUSTED",{type:d.type,amountCents:d.amountCents});
  res.json({balance:{...safeUser(result),availableCents:Math.max(0,result.balanceCents-(result.frozenCents??0))},message:"Client balance adjustment saved."});
}));
app.patch("/api/admin/clients/:id",auth(staff),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const d=z.object({name:z.string().trim().min(2).max(80).optional(),identifier:z.string().trim().min(5).max(120).optional(),password:z.string().min(6).max(100).optional(),active:z.boolean().optional(),balanceCents:z.coerce.number().int().min(0).max(100000000).optional()}).parse(req.body);
  const current=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);
  if(!current)return res.status(404).json({error:"Client not found."});
  let identifier=current.identifier;
  if(d.identifier!==undefined){identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;if(identifier!==current.identifier){const duplicate=await prisma.user.findUnique({where:{identifier}});if(duplicate)return res.status(409).json({error:"That email or phone number is already in use."});}}
  const data:any={};
  if(d.name!==undefined)data.name=d.name;
  if(d.identifier!==undefined){data.identifier=identifier;data.identifierType=detectIdentifier(identifier);}
  if(d.password!==undefined)data.passwordHash=await hashPassword(d.password);
  if(d.active!==undefined)data.active=d.active;
  if(d.balanceCents!==undefined)data.balanceCents=d.balanceCents;
  let u=current;
  if(Object.keys(data).length){u=await prisma.user.update({where:{id},data});await audit(res.locals.auth.sub,id,"CLIENT_UPDATED",{fields:Object.keys(data)});}
  if(d.balanceCents!==undefined&&d.balanceCents!==current.balanceCents){const delta=d.balanceCents-current.balanceCents;await prisma.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:id,amountCents:delta,type:"ADMIN_ADJUSTMENT",note:"Balance updated by staff"}});}
  res.json({user:safeUser(u),message:"Client changes saved."});
}));
app.post("/api/admin/clients",auth([Role.ADMIN]),asyncRoute(async(req,res)=>{
  const d=z.object({name:z.string().trim().min(2).max(80),identifier:z.string().trim().min(5).max(120),password:z.string().min(6).max(100)}).parse(req.body);
  const identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;
  if(await prisma.user.findUnique({where:{identifier}}))return res.status(409).json({error:"That email or phone number is already in use."});
  const u=await prisma.$transaction(async tx=>{
    const c=await tx.user.create({data:{id:await uniqueUserId(),name:d.name,identifier,identifierType:detectIdentifier(identifier),passwordHash:await hashPassword(d.password),role:Role.CLIENT,adminId:res.locals.auth.sub,balanceCents:1000,welcomeBonusGrantedAt:new Date()}});
    await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:c.id,amountCents:1000,type:"WELCOME_BONUS",note:"Welcome balance"}});
    return c;
  });
  await audit(res.locals.auth.sub,u.id,"CLIENT_CREATED",{adminId:res.locals.auth.sub});
  res.status(201).json({client:safeUser(u),message:"Client created successfully."});
}));
app.get("/api/admin/clients/:id/tasks",auth(staff),asyncRoute(async(req,res)=>{const id=param(req,"id");const c=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);if(!c)return res.status(404).json({error:"Client not found."});await ensureTaskBatch(id,res.locals.auth.sub);const tasks=await prisma.task.findMany({where:{clientId:id},orderBy:{sequence:"asc"}});res.json({tasks:tasks.map(t=>taskPublic(t,true)),client:safeUser(c)});}));
app.post("/api/admin/clients/:id/tasks",auth(staff),asyncRoute(async(req,res)=>{const id=param(req,"id");const c=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);if(!c)return res.status(404).json({error:"Client not found."});const d=taskSchema.parse(req.body);const amount=d.amountCents??defaultTaskAmount(c.balanceCents,d.sequence);const commission=d.commissionCents??(d.commissionRateBps!==undefined?Math.round(amount*d.commissionRateBps/10000):defaultCommission(amount));const existing=await prisma.task.findUnique({where:{clientId_sequence:{clientId:id,sequence:d.sequence}}});const task=existing?await prisma.task.update({where:{id:existing.id},data:{title:d.title??existing.title,amountCents:amount,commissionCents:commission,isLucky:d.isLucky??existing.isLucky,assignedById:res.locals.auth.sub,status:TaskStatus.PENDING,revealedAt:null,completedAt:null}}):await prisma.task.create({data:{id:await uniqueTaskId(),clientId:id,assignedById:res.locals.auth.sub,sequence:d.sequence,title:d.title??(d.isLucky?"Lucky combination":"Daily task"),amountCents:amount,commissionCents:commission,isLucky:d.isLucky??false}});res.json({task:taskPublic(task,true),message:"Task saved for this client."});}));
app.post("/api/admin/clients/:id/tasks/reset",auth(staff),asyncRoute(async(req,res)=>{const id=param(req,"id");const c=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);if(!c)return res.status(404).json({error:"Client not found."});const count=z.object({count:z.coerce.number().int().min(1).max(20).optional()}).parse(req.body||{}).count??5;await prisma.$transaction(async tx=>{await tx.task.deleteMany({where:{clientId:id}});for(let i=1;i<=count;i++){const amount=defaultTaskAmount(c.balanceCents,i);await tx.task.create({data:{id:await uniqueTaskId(),clientId:id,assignedById:res.locals.auth.sub,sequence:i,title:i===2?"Lucky combination":"Daily task",amountCents:amount,commissionCents:defaultCommission(amount),isLucky:i===2}});}});const tasks=await prisma.task.findMany({where:{clientId:id},orderBy:{sequence:"asc"}});res.json({tasks:tasks.map(t=>taskPublic(t,true)),message:"Tasks reset and rebuilt."});}));
app.get("/api/admin/messages",auth(staff),asyncRoute(async(_req,res)=>{const role=res.locals.auth.role;const messages=await prisma.message.findMany({where:role===Role.OWNER?{}:{OR:[{senderId:res.locals.auth.sub},{recipientId:res.locals.auth.sub},{sender:{adminId:res.locals.auth.sub}},{recipient:{adminId:res.locals.auth.sub}}]},include:{sender:{select:{id:true,name:true,identifier:true,role:true,adminId:true}},recipient:{select:{id:true,name:true,role:true}}},orderBy:{createdAt:"desc"}});res.json({messages});}));
app.post("/api/admin/clients/:id/messages",auth([Role.ADMIN]),asyncRoute(async(req,res)=>{const id=param(req,"id");const d=messageSchema.omit({recipientId:true}).parse(req.body);const c=await prisma.user.findFirst({where:{id,role:Role.CLIENT,adminId:res.locals.auth.sub,active:true}});if(!c)return res.status(404).json({error:"Client not found in your workspace."});const msg=await prisma.message.create({data:{id:await uniqueMessageId(),senderId:res.locals.auth.sub,recipientId:c.id,subject:d.subject,body:d.body}});res.status(201).json({message:msg});}));
app.patch("/api/admin/messages/:id",auth(staff),asyncRoute(async(req,res)=>{const id=param(req,"id");const d=z.object({status:z.enum(["OPEN","REPLIED","CLOSED"]),reply:z.string().max(3000).optional()}).parse(req.body);const current=await prisma.message.findUniqueOrThrow({where:{id},include:{sender:{select:{id:true,role:true,adminId:true}}}});if(res.locals.auth.role===Role.ADMIN&&current.sender.role===Role.CLIENT&&current.sender.adminId!==res.locals.auth.sub)return res.status(403).json({error:"This conversation is outside your workspace."});let reply=null;if(d.reply?.trim())reply=await prisma.message.create({data:{id:await uniqueMessageId(),senderId:res.locals.auth.sub,recipientId:current.senderId,subject:`Re: ${current.subject}`,body:d.reply.trim(),status:MessageStatus.REPLIED}});const message=await prisma.message.update({where:{id},data:{status:d.status}});res.json({message,reply});}));

app.get("/api/owner/admins",auth([Role.OWNER]),asyncRoute(async(_req,res)=>{
  const admins=await prisma.user.findMany({where:{role:Role.ADMIN},orderBy:{createdAt:"desc"}});
  const rows=await Promise.all(admins.map(async a=>{
    const setting=await prisma.setting.findUnique({where:{key:`telegram_admin_${a.id}`}});
    return {...safeUser(a),inviteCode:a.inviteCode,telegramUsername:setting?.value||""};
  }));
  res.json({admins:rows});
}));
app.post("/api/owner/admins",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const d=z.object({name:z.string().trim().min(2).max(80),identifier:z.string().trim().min(5).max(120),password:z.string().min(6).max(100)}).parse(req.body);const identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;if(await prisma.user.findUnique({where:{identifier}}))return res.status(409).json({error:"That email or phone number is already in use."});const inviteCode=await uniqueInviteCode();const admin=await prisma.user.create({data:{id:await uniqueUserId(),name:d.name,identifier,identifierType:detectIdentifier(identifier),passwordHash:await hashPassword(d.password),role:Role.ADMIN,inviteCode}});await audit(res.locals.auth.sub,admin.id,"ADMIN_CREATED",{inviteCode});res.status(201).json({admin:{...safeUser(admin),inviteCode},message:"Admin created successfully."});}));
app.patch("/api/owner/admins/:id",auth([Role.OWNER]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const d=z.object({name:z.string().trim().min(2).max(80).optional(),identifier:z.string().trim().min(5).max(120).optional(),password:z.string().min(6).max(100).optional(),active:z.boolean().optional(),telegramUsername:z.string().trim().max(120).optional()}).parse(req.body);
  const admin=await prisma.user.findFirst({where:{id,role:Role.ADMIN}});
  if(!admin)return res.status(404).json({error:"Admin not found."});
  let identifier=admin.identifier;
  if(d.identifier!==undefined){identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;if(identifier!==admin.identifier){const duplicate=await prisma.user.findUnique({where:{identifier}});if(duplicate)return res.status(409).json({error:"That email or phone number is already in use."});}}
  const data:any={};
  if(d.name!==undefined)data.name=d.name;
  if(d.identifier!==undefined){data.identifier=identifier;data.identifierType=detectIdentifier(identifier);}
  if(d.password!==undefined)data.passwordHash=await hashPassword(d.password);
  if(d.active!==undefined)data.active=d.active;
  const u=await prisma.user.update({where:{id},data});
  if(d.telegramUsername!==undefined){const key=`telegram_admin_${id}`;if(d.telegramUsername.trim())await prisma.setting.upsert({where:{key},create:{id:await uniqueSettingId(),key,value:d.telegramUsername.trim().replace(/^@/,"")},update:{value:d.telegramUsername.trim().replace(/^@/,"")}});else await prisma.setting.deleteMany({where:{key}});}
  const telegramSetting=await prisma.setting.findUnique({where:{key:`telegram_admin_${id}`}});
  await audit(res.locals.auth.sub,id,"ADMIN_UPDATED",{fields:[...Object.keys(data),...(d.telegramUsername!==undefined?["telegramUsername"]:[])]});
  res.json({admin:{...safeUser(u),inviteCode:u.inviteCode,telegramUsername:telegramSetting?.value||""},message:"Admin changes saved."});
}));
app.delete("/api/owner/admins/:id",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const id=param(req,"id");const admin=await prisma.user.findFirst({where:{id,role:Role.ADMIN}});if(!admin)return res.status(404).json({error:"Admin not found."});await audit(res.locals.auth.sub,id,"ADMIN_DELETED");await prisma.user.delete({where:{id}});res.json({message:"Admin removed."});}));
app.post("/api/owner/clients",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const d=z.object({name:z.string().trim().min(2).max(80),identifier:z.string().trim().min(5).max(120),password:z.string().min(6).max(100),adminId:z.string().regex(/^\d{5}$/)}).parse(req.body);const identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;const admin=await prisma.user.findFirst({where:{id:d.adminId,role:Role.ADMIN,active:true}});if(!admin)return res.status(400).json({error:"Choose an active administrator."});if(await prisma.user.findUnique({where:{identifier}}))return res.status(409).json({error:"That email or phone number is already in use."});const u=await prisma.$transaction(async tx=>{const c=await tx.user.create({data:{id:await uniqueUserId(),name:d.name,identifier,identifierType:detectIdentifier(identifier),passwordHash:await hashPassword(d.password),role:Role.CLIENT,adminId:admin.id,balanceCents:1000,welcomeBonusGrantedAt:new Date()}});await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:c.id,amountCents:1000,type:"WELCOME_BONUS",note:"Welcome balance"}});return c;});res.status(201).json({client:safeUser(u),message:"Client created successfully."});}));
app.delete("/api/owner/clients/:id",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const id=param(req,"id");const c=await prisma.user.findFirst({where:{id,role:Role.CLIENT}});if(!c)return res.status(404).json({error:"Client not found."});await audit(res.locals.auth.sub,id,"CLIENT_DELETED");await prisma.user.delete({where:{id}});res.json({message:"Client removed."});}));
app.get("/api/owner/users/:id",auth([Role.OWNER]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const user=await prisma.user.findUnique({where:{id},include:{admin:{select:{id:true,name:true,identifier:true,active:true}},managedClients:{select:{id:true,name:true,identifier:true,active:true}},walletTransactions:{orderBy:{createdAt:"desc"},take:30},tasks:{orderBy:{sequence:"asc"}},messagesSent:{orderBy:{createdAt:"desc"},take:20},messagesOwned:{orderBy:{createdAt:"desc"},take:20}}});
  if(!user||user.role===Role.OWNER)return res.status(404).json({error:"Account not found."});
  const auditLogs=await prisma.auditLog.findMany({where:{OR:[{targetId:id},{actorId:id}]},orderBy:{createdAt:"desc"},take:50});
  const telegramSetting=user.role===Role.ADMIN?await prisma.setting.findUnique({where:{key:`telegram_admin_${id}`} }):null;
  res.json({user:{...safeUser(user),inviteCode:user.role===Role.ADMIN?user.inviteCode:null,telegramUsername:telegramSetting?.value||""},admin:user.admin?{id:user.admin.id,name:user.admin.name,identifier:user.admin.identifier,active:user.admin.active}:null,clients:user.managedClients.map(safeUser),transactions:user.walletTransactions,tasks:user.tasks.map(t=>taskPublic(t,true)),messages:[...user.messagesSent,...user.messagesOwned],auditLogs});
}));
app.get("/api/owner/audit",auth([Role.OWNER]),asyncRoute(async(req,res)=>{
  const take=Math.min(Number(req.query.take||100),250);
  const logs=await prisma.auditLog.findMany({take,orderBy:{createdAt:"desc"},include:{actor:{select:{id:true,name:true,role:true}},target:{select:{id:true,name:true,role:true}}}});
  res.json({logs});
}));
app.get("/api/owner/settings",auth([Role.OWNER]),asyncRoute(async(_req,res)=>res.json({settings:await prisma.setting.findMany({orderBy:{key:"asc"}})})));
app.patch("/api/owner/settings/:key",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const key=param(req,"key");const d=z.object({value:z.string().max(1000)}).parse(req.body);const setting=await prisma.setting.upsert({where:{key},create:{id:await uniqueSettingId(),key,value:d.value},update:{value:d.value}});res.json({setting});}));

app.use((req,res)=>res.status(404).json({error:"Route not found.",path:req.path}));
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(err instanceof z.ZodError)return res.status(422).json({error:err.issues[0]?.message||"Please check the submitted details.",code:"VALIDATION_ERROR"});
  if(err instanceof Error&&err.message==="Origin is not allowed by CORS.")return res.status(403).json({error:"This origin is not allowed to access the API.",code:"CORS_FORBIDDEN"});
  console.error(err);
  if(isProduction)return res.status(500).json({error:"An unexpected server error occurred.",code:"INTERNAL_ERROR"});
  return res.status(500).json({error:err instanceof Error?err.message:"Something went wrong. Please try again.",code:"INTERNAL_ERROR"});
});

const server=app.listen(port,"0.0.0.0",()=>{console.log(`Box Office Mojo API listening on ${port}`);void runMigrationsUntilReady();});
server.on("error",e=>{console.error(e);process.exitCode=1;});
function runMigrations(){return new Promise<void>((resolve,reject)=>{const args=["prisma","migrate","deploy","--schema=prisma/schema.prisma"];migrationProcess=execFile(process.platform==="win32"?(process.env.ComSpec||"cmd.exe"):"npx",process.platform==="win32"?["/d","/s","/c","npx "+args.join(" ")]:args,{cwd:process.cwd(),env:process.env,windowsHide:true},(error,stdout,stderr)=>{migrationProcess=null;if(stdout.trim())console.log(stdout.trim());if(stderr.trim())console.error(stderr.trim());error?reject(error):resolve();});});}
async function runMigrationsUntilReady(){let delay=2000;while(!applicationReady){try{await runMigrations();await prisma.$queryRaw`SELECT 1`;await ensureOwnerFromEnv();applicationReady=true;console.log("Database ready.");}catch(e){console.error(`Database/migration startup failed; retrying in ${Math.ceil(delay/1000)}s`,e);await new Promise(r=>setTimeout(r,delay));delay=Math.min(delay*2,30000);}}}
async function shutdown(signal:string){console.log(`${signal} received.`);if(migrationProcess) migrationProcess.kill();await prisma.$disconnect();server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000);}
process.on("SIGINT",()=>void shutdown("SIGINT"));process.on("SIGTERM",()=>void shutdown("SIGTERM"));
