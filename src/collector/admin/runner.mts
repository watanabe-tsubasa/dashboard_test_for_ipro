import { validId } from "./input.mts";
import { openJobs } from "./jobs.mts";
import { runJob } from "./run-job.mts";

const id = process.argv[2];
if (process.argv.length !== 3 || !id || !validId(id)) {
  process.exitCode = 2;
} else {
  const jobs = openJobs();
  try {
    process.exitCode = await runJob(id, jobs, process.env);
  } finally {
    jobs.close();
  }
}
