import {
  createCutFileWorkerHandler,
  type CutFileWorkerScope,
} from "@onoxm/utils/web/cutFile";
import { myHash } from "./hash";

const scope = self as unknown as CutFileWorkerScope;
scope.onmessage = createCutFileWorkerHandler(myHash);
