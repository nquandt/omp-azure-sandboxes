export const OMP_VERSION = "18.22.2";
export const WORKER_IMAGE_REVISION = 29;
export const WORKER_IMAGE_TAG = `${OMP_VERSION}-r${WORKER_IMAGE_REVISION}`;
export const WORKER_DISK_NAME =
  `sand-omp-${OMP_VERSION.replaceAll(".", "-")}-r${WORKER_IMAGE_REVISION}`;
