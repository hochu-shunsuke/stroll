/**
 * 木形状の互換窓口。
 *
 * 呼び出し側は従来どおりこのファイルから読める。実装は広葉樹の枝構造、
 * 針葉樹、椰子、公開カタログへ分け、各形の調整が互いに干渉しないようにする。
 */
export {
  TREE_UP,
  branchGeometry,
  buildTree,
  paint,
  type TreeParams,
} from './treeGeometry';
export { buildConifer, type ConiferParams } from './coniferShape';
export { buildPalm } from './palmShape';
export {
  TREE_CATALOG,
  buildCatalogGeometry,
  type CatalogEntry,
} from './treeCatalog';
