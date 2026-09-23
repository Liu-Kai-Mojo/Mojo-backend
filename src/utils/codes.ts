import { prisma } from "../prisma.js";
import { randomInt } from "node:crypto";
const MAX_ATTEMPTS=100;
export function randomFiveDigits(){return String(randomInt(10000,100000));}
async function uniqueCode<T>(exists:(id:string)=>Promise<T|null>){for(let i=0;i<MAX_ATTEMPTS;i++){const id=randomFiveDigits();if(!(await exists(id)))return id;}throw new Error("Unable to allocate a unique five-digit identifier.");}
export const uniqueUserId=()=>uniqueCode(id=>prisma.user.findUnique({where:{id}}));
export const uniqueMovieId=()=>uniqueCode(id=>prisma.movie.findUnique({where:{id}}));
export const uniqueHistoryId=()=>uniqueCode(id=>prisma.movieHistory.findUnique({where:{id}}));
export const uniqueMessageId=()=>uniqueCode(id=>prisma.message.findUnique({where:{id}}));
export const uniqueSettingId=()=>uniqueCode(id=>prisma.setting.findUnique({where:{id}}));
export const uniqueWalletTransactionId=()=>uniqueCode(id=>prisma.walletTransaction.findUnique({where:{id}}));
export const uniqueTaskId=()=>uniqueCode(id=>prisma.task.findUnique({where:{id}}));
export const uniqueInviteCode=()=>uniqueCode(code=>prisma.user.findUnique({where:{inviteCode:code}}));
export const uniqueAuditLogId=()=>uniqueCode(id=>prisma.auditLog.findUnique({where:{id}}));
