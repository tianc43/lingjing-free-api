import type { AdmissionInput, AdmissionResult } from "../accounts/types.js";
import type { BudgetState } from "../accounts/sqlite-admission-repository.js";
import type { JobFence, JobListFilter, JobRecord, JobResult, JobStatus, JobTransition, NewJob } from "../jobs/types.js";

/** Transaction-group ports, not one interface per table. */
export interface JobStorePort {
  createOrGet(input:NewJob):{created:boolean;job:JobRecord};
  findById(id:string):JobRecord|null;
  list(filter:JobListFilter):JobRecord[];
  transition(id:string,expected:readonly JobStatus[],transition:JobTransition,fence?:JobFence):JobRecord;
  cancelQueued(id:string,projectId:string):JobRecord|null;
  archiveDue(now:number,limit:number):JobRecord[];
  replaceArchivedResult(id:string,result:JobResult,fence?:JobFence):void;
  markArchiveFailure(id:string,error:string,fence?:JobFence):void;
}
export interface AdmissionLedgerPort {
  reserveOrGet(input:AdmissionInput):AdmissionResult;
  charge(jobId:string):void;
  releasePreSubmit(jobId:string):void;
  failAndRelease(jobId:string,expected:readonly JobStatus[],errorCode:string):JobRecord;
  resolveUnknown(accountId:string,jobId:string,action:"charge"|"release"):{state:BudgetState;job:JobRecord};
  budgetState(jobId:string):BudgetState|null;
}
export interface WorkerLeasePort<TLease> {
  acquire(jobId:string,workerId:string,durationMs:number):TLease|null;
  heartbeat(lease:TLease,durationMs:number):TLease|null;
  owns(lease:TLease):boolean;
  release(lease:TLease):boolean;
}
