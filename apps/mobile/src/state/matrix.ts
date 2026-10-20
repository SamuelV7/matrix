import { createMatrixEnvironmentAtoms } from "@t3tools/client-runtime/state/matrix";
import { connectionAtomRuntime } from "../connection/runtime";

export const matrixEnvironment = createMatrixEnvironmentAtoms(connectionAtomRuntime);
