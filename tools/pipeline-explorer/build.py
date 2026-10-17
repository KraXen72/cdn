"""Build a standalone, interactive map of the current pipeline's actual handoffs."""

import ast
import html
import json
import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DESTINATION = Path(__file__).resolve().parent
NODES = {}
EDGES = []
GROUPS = {
    "runner": ("00 · Orchestration", "The local runner coordinates stages and retrieves their in-memory payloads."),
    "acquisition": ("01 · Acquisition", "Fetch/cache BGT GeoPackages, then decode source records."),
    "transformation": ("02 · Transformation", "Normalize source records into level-aware surfaces in EPSG:28992."),
    "skeletonization": ("03 · Skeletonization", "Generate centerlines; return references and retain payloads in the context."),
    "cleanup": ("04 · Centerline cleanup", "Smooth centerlines; optional gap cleanup is disabled by default."),
    "construction": ("05 · Graph construction", "Build nodes, edges, graph QA and derived counts."),
    "validation": ("06 · Validation & runner result", "Validate the generated graph and collect results from the contexts."),
    "export": ("07 · Standard export", "Write generated DWN files from run_pipeline.main()."),
    "corrections": ("08 · Corrections · Den Haag demo", "An additional demo path after run_stages(); absent from the standard runner."),
}


def source_details(path, symbol):
    """Read signatures, fields and source directly from the current Python code."""
    source = (ROOT / path).read_text()
    tree = ast.parse(source)
    current = tree
    for part in symbol.split("."):
        current = next(item for item in current.body if getattr(item, "name", None) == part)
    fields = []
    if isinstance(current, ast.ClassDef):
        for item in current.body:
            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                default = " = " + ast.unparse(item.value) if item.value else ""
                fields.append(f"{item.target.id}: {ast.unparse(item.annotation)}{default}")
    signature = None
    if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
        returns = " -> " + ast.unparse(current.returns) if current.returns else ""
        signature = f"{current.name}({ast.unparse(current.args)}){returns}"
    return {
        "path": path,
        "line": current.lineno,
        "doc": ast.get_docstring(current) or "",
        "fields": fields,
        "signature": signature,
        "code": ast.get_source_segment(source, current),
    }


def node(identifier, label, kind, group, role, *, path=None, symbol=None, sub="", notes=(), detailed=False):
    NODES[identifier] = {
        "id": identifier, "label": label, "kind": kind, "group": group,
        "role": role, "sub": sub, "notes": list(notes), "detailed": detailed,
        "source": source_details(path, symbol) if path and symbol else None,
    }
    return identifier


def model(identifier, name, group, role, path="pipeline/contracts/models.py", symbol=None, **kwargs):
    return node(identifier, name, "model", group, role, path=path, symbol=symbol or name, **kwargs)


def function(identifier, name, group, role, path, symbol=None, *, stage=False, **kwargs):
    return node(identifier, name + "()", "stage" if stage else "function", group, role,
                path=path, symbol=symbol or name, **kwargs)


def edge(start, end, label, kind="data", *, detailed=False):
    assert start in NODES and end in NODES, (start, end)
    EDGES.append({"id": f"edge_{len(EDGES)}", "from": start, "to": end,
                  "label": label, "kind": kind, "detailed": detailed})


# The diagram follows run_pipeline.run_stages(), with the Den Haag demo as a branch.
function("runner", "run_stages", "runner", "Coordinates the generation stages. Data remains in Python memory between stages; it does not apply patches or export the DWN.",
         "pipeline_tools/run_pipeline.py", stage=True,
         notes=["The CLI main() calls run_stages(), then write_outputs() and build_run_info().",
                "Settings, run_id and timing data are supplied by the caller."])
model("acq_settings", "AcquisitionSettings", "acquisition", "Selects the area, BGT layers, filters and cache refresh behavior.",
      "pipeline/contracts/models_acquisition.py")
function("acq", "data_acquisition_stage", "acquisition", "Reads cached BGT highway data into typed source records. With settings, it first ensures the cache exists.",
         "pipeline/stages/acquisition.py", stage=True,
         notes=["run_stages() calls fetch_bgt_if_needed() separately for timing, then this function calls it again. With refresh=False the second call reuses the cache; refresh=True can fetch twice."])
function("fetch", "fetch_bgt_if_needed", "acquisition", "Returns a cache folder; downloads from PDOK when the request is absent or refresh is enabled.", "pipeline/stages/acquisition.py", detailed=True)
function("read_bgt", "read_bgt_layer", "acquisition", "Decodes a GeoPackage into BGTFeature records, including identity, lifecycle and relative height.", "pipeline/stages/acquisition.py", detailed=True)
node("bgt_cache", "BGT cache · GeoPackage", "file", "acquisition", "Actual files written by acquisition: bgt_highway.gpkg and request.json under pipeline/data/raw/<request>/.", sub="disk · EPSG:28992")
model("bgt", "BGTFeature", "acquisition", "Source-specific records before normalization. The standard runner currently reads BGT, although the batch type also permits OSMFeature.", "pipeline/contracts/models_bgt.py", detailed=True)
model("bgt_id", "BGTIdentifier", "acquisition", "Namespaced identity of one source BGT object.", "pipeline/contracts/models_bgt.py", detailed=True)
model("bgt_life", "BGTLifecycle", "acquisition", "Source status and beginning/end timestamps.", "pipeline/contracts/models_bgt.py", detailed=True)
model("batch", "AcquiredFeatureBatch", "acquisition", "Groups source records with their CRS and source kind.", "pipeline/contracts/stage_contracts.py", detailed=True)
model("acq_out", "AcquisitionOutput", "acquisition", "The real return value: source feature batches, containing their data directly.", "pipeline/contracts/stage_contracts.py", sub="batches → source records")
edge("acq_settings", "acq", "settings argument")
edge("bgt_cache", "acq", "reads cached BGT highway layer")
edge("acq", "acq_out", "returns actual batches")
edge("acq", "fetch", "calls; also called by runner", "call", detailed=True)
edge("acq_settings", "fetch", "area / filters / refresh", detailed=True)
edge("fetch", "bgt_cache", "fetches or reuses cache", detailed=True)
edge("bgt_cache", "read_bgt", "GeoPackage path", detailed=True)
edge("acq", "read_bgt", "calls", "call", detailed=True)
edge("read_bgt", "bgt", "returns list[BGTFeature]", detailed=True)
edge("bgt_id", "bgt", "identifier field", "contains", detailed=True)
edge("bgt_life", "bgt", "lifecycle field", "contains", detailed=True)
edge("bgt", "batch", "features sequence", "contains", detailed=True)
edge("batch", "acq_out", "batches list", "contains", detailed=True)

model("trans_input", "TransformationInput", "transformation", "Wraps AcquisitionOutput, run_id and TransformationSettings for a direct in-memory call.", "pipeline/contracts/models_transformation.py")
model("trans_settings", "TransformationSettings", "transformation", "Defaults: merge nearby same-source/same-level surfaces; geometry simplification disabled.", "pipeline/contracts/models_transformation.py", detailed=True)
function("trans", "transformation_stage", "transformation", "Normalizes BGT/OSM identity and attributes, reprojects if necessary and optionally simplifies/merges surfaces. Returns actual SurfaceFeature records.", "pipeline/stages/transformation.py", stage=True,
         notes=["The normalization, simplification and merging functions are private, so they are described here rather than drawn as separate function nodes.", "TransformationOutputWithMetadata is declared but is not returned or used by this runner."])
model("trans_out", "TransformationOutput", "transformation", "Contains the normalized surface data directly, plus the internal CRS.", "pipeline/contracts/stage_contracts.py", sub="crs + features")
model("surfaces", "SurfaceFeature", "transformation", "Domain-level surface geometry, relative level, source identity and attributes. Usually polygons here; existing OSM lines can pass through in other callers.", sub="list · actual geometry")
function("make_surface", "make_surface_artifact", "transformation", "Builds metadata for the surface payload already held in memory. Does not write surface files.", "pipeline_tools/artifacts.py", detailed=True)
node("surface_ref", "ArtifactRef · surfaces", "reference", "transformation", "Metadata describing surfaces, including memory://surfaces, area, CRS, count and producer. The geometry is held separately in the skeletonization context.", path="pipeline/contracts/models_graph_construction.py", symbol="ArtifactRef", sub="metadata · not the surfaces")
edge("acq_out", "trans_input", "acquisition field")
edge("trans_settings", "trans_input", "settings field", "contains", detailed=True)
edge("trans_input", "trans", "stage_input argument")
edge("trans", "trans_out", "returns")
edge("trans_out", "surfaces", "features field", "contains")
edge("surfaces", "surface_ref", "runner describes the payload", "reference")
edge("surfaces", "make_surface", "features + run_id", detailed=True)
edge("make_surface", "surface_ref", "returns metadata only", "reference", detailed=True)

model("skel_input", "SkeletonizationInput", "skeletonization", "Contains a surface ArtifactRef, run_id and settings. The actual surface features are supplied separately through context.", "pipeline/contracts/models_skeletonization.py")
model("skel_settings", "SkeletonizationSettings", "skeletonization", "Selects raster method, resolution and branch pruning settings.", "pipeline/contracts/models_skeletonization.py", detailed=True)
function("skel", "skeletonization_stage", "skeletonization", "Loads surfaces from context, generates centerlines and QA, writes them through context, and returns artifact references.", "pipeline/stages/skeletonization.py", stage=True,
         notes=["Polygon processing: rasterize → skeletonize → optionally prune short branches → trace pixels into lines. These implementation functions are private.", "A LineString surface becomes a Centerline directly.", "The runner imports SkeletonizationOutput from models_skeletonization.py. The same-named payload class in stage_contracts.py is not used in this path."])
node("skel_ctx", "InMemorySkeletonizationContext", "context", "skeletonization", "Holds surface_features, resulting centerlines and qa_findings. load/write methods access Python attributes; no centerline files are written.", path="pipeline_tools/demo_skeletonization.py", symbol="InMemorySkeletonizationContext", sub="real data lives here")
function("skel_load", "context.load_surface_features", "skeletonization", "Returns the surfaces stored on this context; the memory reference is descriptive.", "pipeline_tools/demo_skeletonization.py", "InMemorySkeletonizationContext.load_surface_features", detailed=True)
function("skel_write", "context.write_centerlines", "skeletonization", "Keeps centerlines and QA on the context and returns CenterlineArtifactRefs. This is not a GeoPackage/GeoJSON export.", "pipeline_tools/demo_skeletonization.py", "InMemorySkeletonizationContext.write_centerlines", detailed=True)
model("skel_refs", "CenterlineArtifactRefs", "skeletonization", "Internal pair of metadata references returned by context.write_centerlines().", "pipeline/contracts/models_skeletonization.py", detailed=True)
model("skel_out", "SkeletonizationOutput", "skeletonization", "Public stage return value: run ID, centerline/QA references and metadata. Contains no actual centerline list.", "pipeline/contracts/models_skeletonization.py", sub="references + metadata")
model("raw_lines", "Centerline · raw", "skeletonization", "Actual centerline records read by the runner from skeleton_context.centerlines. Each record has coordinates and source provenance.", symbol="Centerline", sub="list · actual coordinates")
edge("surface_ref", "skel_input", "surface_feature_artifact", "reference")
edge("surfaces", "skel_ctx", "runner seeds context.surface_features", "context")
edge("skel_settings", "skel_input", "settings field", "contains", detailed=True)
edge("skel_input", "skel", "stage_input argument")
edge("skel_ctx", "skel", "context argument / surface payload", "context")
edge("skel", "skel_ctx", "retains generated centerlines + QA", "context")
edge("skel", "skel_out", "returns references", "reference")
edge("skel_ctx", "raw_lines", "runner reads .centerlines", "context")
edge("skel", "skel_load", "loads via context", "call", detailed=True)
edge("skel_ctx", "skel_load", "stored surface_features", "context", detailed=True)
edge("skel_load", "skel", "list[SurfaceFeature]", detailed=True)
edge("skel", "skel_write", "centerlines + findings", detailed=True)
edge("skel_write", "skel_ctx", "sets .centerlines / .qa_findings", "context", detailed=True)
edge("skel_write", "skel_refs", "returns", "reference", detailed=True)
edge("skel_refs", "skel_out", "copied into output fields", "reference", detailed=True)

model("clean_input", "SkeletonizationCleanupInput", "cleanup", "Receives the raw centerline reference from skeleton_output, plus run_id and settings.", "pipeline/contracts/models_skeletonization_cleanup.py")
model("clean_settings", "SkeletonizationCleanupSettings", "cleanup", "Defaults: smoothing enabled, gap cleanup disabled. Includes resolution, smoothing tolerance and gap limits.", "pipeline/contracts/models_skeletonization_cleanup.py", detailed=True)
function("clean", "skeletonization_cleanup_stage", "cleanup", "Loads centerlines from context, smooths them and optionally bridges gaps. Writes payload and QA through context, then returns references.", "pipeline/stages/skeletonization_cleanup.py", stage=True,
         notes=["Smoothing and gap cleanup are private implementation functions and intentionally not separate nodes.", "run_stages() discards this function's returned SkeletonizationCleanupOutput. It reads cleaned_centerlines directly from the context instead."])
node("clean_ctx", "InMemorySkeletonizationCleanupContext", "context", "cleanup", "The runner seeds this with raw centerlines, then reads .cleaned_centerlines and .qa_findings after the stage.", path="pipeline_tools/demo_skeletonization.py", symbol="InMemorySkeletonizationCleanupContext", sub="real data lives here")
function("clean_load", "context.load_centerlines", "cleanup", "Returns the raw centerlines supplied when constructing this context.", "pipeline_tools/demo_skeletonization.py", "InMemorySkeletonizationCleanupContext.load_centerlines", detailed=True)
function("clean_write", "context.write_centerlines", "cleanup", "Stores cleaned centerlines and QA in memory; returns CenterlineCleanupArtifactRefs.", "pipeline_tools/demo_skeletonization.py", "InMemorySkeletonizationCleanupContext.write_centerlines", detailed=True)
model("clean_refs", "CenterlineCleanupArtifactRefs", "cleanup", "Internal references describing the cleaned centerline and QA payloads.", "pipeline/contracts/models_skeletonization_cleanup.py", detailed=True)
model("clean_out", "SkeletonizationCleanupOutput", "cleanup", "Returned references and metadata. Currently ignored by run_stages(); not the source of GraphConstructionInput in this runner.", "pipeline/contracts/models_skeletonization_cleanup.py", sub="returned · ignored by runner")
model("clean_lines", "Centerline · cleaned", "cleanup", "Actual cleaned records read from cleanup_context.cleaned_centerlines. Used both for graph construction and final centerline export.", symbol="Centerline", sub="list · actual coordinates")
edge("skel_out", "clean_input", "centerline_artifact field", "reference")
edge("raw_lines", "clean_ctx", "runner seeds context.centerlines", "context")
edge("clean_settings", "clean_input", "settings field", "contains", detailed=True)
edge("clean_input", "clean", "stage_input argument")
edge("clean_ctx", "clean", "context argument / raw centerlines", "context")
edge("clean", "clean_ctx", "retains cleaned centerlines + QA", "context")
edge("clean", "clean_out", "returns references", "reference")
edge("clean_ctx", "clean_lines", "runner reads .cleaned_centerlines", "context")
edge("clean", "clean_load", "loads via context", "call", detailed=True)
edge("clean_ctx", "clean_load", "stored raw centerlines", "context", detailed=True)
edge("clean_load", "clean", "list[Centerline]", detailed=True)
edge("clean", "clean_write", "cleaned centerlines + findings", detailed=True)
edge("clean_write", "clean_ctx", "sets payload + QA attributes", "context", detailed=True)
edge("clean_write", "clean_refs", "returns", "reference", detailed=True)
edge("clean_refs", "clean_out", "copied into output fields", "reference", detailed=True)

model("graph_input", "GraphConstructionInput", "construction", "Run identity, centerline ArtifactRef and graph settings. The runner makes a new reference from cleaned records rather than forwarding CleanupOutput.", "pipeline/contracts/models_graph_construction.py")
model("graph_settings", "GraphConstructionSettings", "construction", "Controls minimum derived edge length for QA. The runner uses 0.01 metres.", "pipeline/contracts/models_graph_construction.py", detailed=True)
function("make_graph_input", "make_graph_construction_input", "construction", "Builds an in-memory centerline ArtifactRef and GraphConstructionInput from the cleaned records. Writes no files.", "fixtures/graph_construction.py", detailed=True)
function("graph", "graph_construction_stage", "construction", "Normalizes loops, merges exact duplicates, splits same-level intersections, builds graph records, adds QA, and writes through context.", "pipeline/stages/graph_construction.py", stage=True)
node("graph_ctx", "InMemoryGraphContext", "context", "construction", "Holds input centerlines and output written_graph/written_qa_findings. No graph files are written by this implementation.", path="fixtures/graph_construction.py", symbol="InMemoryGraphContext", sub="real data lives here")
function("graph_load", "context.load_centerlines", "construction", "Returns the cleaned centerlines supplied to InMemoryGraphContext.", "fixtures/graph_construction.py", "InMemoryGraphContext.load_centerlines", detailed=True)
function("graph_write", "context.write_graph", "construction", "Retains GraphBuild and QA in memory; returns graph/QA ArtifactRefs with memory:// URIs. Does not create export files.", "fixtures/graph_construction.py", "InMemoryGraphContext.write_graph", detailed=True)
model("graph_refs", "GraphArtifactRefs", "construction", "Internal graph/QA reference pair returned by write_graph().", "pipeline/contracts/models_graph_construction.py", detailed=True)
model("graph_out", "GraphConstructionOutput", "construction", "Small public return value containing run identity, graph/QA references, summary and metadata. GraphBuild is retained separately by context.", "pipeline/contracts/models_graph_construction.py", sub="references + summary + metadata")
model("graph_build", "GraphBuild · generated", "construction", "The actual generated DWN in memory: nodes, edges, QA findings and derived summary. The runner reads this from graph_context.written_graph.", symbol="GraphBuild", sub="actual DWN records")
model("graph_nodes", "GraphNode", "construction", "Routable endpoint, junction or loop anchor, with coordinates, level, degree, attributes and provenance.", detailed=True)
model("graph_edges", "GraphEdge", "construction", "A graph connection: endpoint IDs, LineString geometry, level, routing attributes and source/patch provenance.", detailed=True)
model("summary", "GraphSummary", "construction", "Derived statistics only, with no geometry: node/edge/component counts, degree histogram and QA count. Stored on GraphBuild and copied into GraphConstructionOutput.", sub="derived counts · no geometry")
model("qa", "QAFinding", "validation", "A reviewable observation with stage/run identity, severity, message and optional feature IDs/location. Several stages produce lists of these.", sub="shared QA record", detailed=True)
for identifier, name, role in [
    ("normalize", "normalize_closed_loops", "Canonicalizes loop anchors and orientation before comparing duplicate geometry."),
    ("deduplicate", "process_exact_duplicates", "Represents identical same-level lines once and records their provenance groups."),
    ("split", "split_at_same_level_intersections", "Splits centerlines at crossings and overlap boundaries on the same level."),
    ("build_records", "build_graph_from_pieces", "Converts centerline pieces to level-aware GraphNode and GraphEdge records."),
    ("provenance", "apply_duplicate_provenance", "Adds source provenance from merged duplicate centerlines to the graph records."),
    ("crossing_qa", "build_level_separated_crossing_findings", "Reports 2D crossings intentionally left disconnected because levels differ."),
    ("graph_qa", "build_qa_findings", "Collects graph topology/geometry findings, duplicate-merge findings and level-separated crossings."),
]:
    function(identifier, name, "construction", role, "pipeline/stages/graph_construction.py", detailed=True)
model("duplicates", "DuplicateProcessingResult", "construction", "Carries representative centerlines plus duplicate merge groups used to preserve provenance and create QA.", "pipeline/stages/graph_construction.py", detailed=True)
function("make_summary", "build_graph_summary", "construction", "Derives node, edge, component and degree counts from the actual graph records.", "pipeline/util/graph_manipulation.py", detailed=True)
edge("clean_lines", "graph_input", "runner constructs a new input/ref", "reference")
edge("clean_lines", "graph_ctx", "runner seeds context.centerlines", "context")
edge("clean_lines", "make_graph_input", "centerlines + run_id + settings", detailed=True)
edge("make_graph_input", "graph_input", "returns envelope", "reference", detailed=True)
edge("graph_settings", "graph_input", "settings field", "contains", detailed=True)
edge("graph_input", "graph", "stage_input argument")
edge("graph_ctx", "graph", "context argument / centerline payload", "context")
edge("graph", "graph_ctx", "retains generated GraphBuild", "context")
edge("graph_ctx", "graph_build", "runner reads .written_graph", "context")
edge("graph", "graph_out", "returns references + summary", "reference")
edge("graph_build", "summary", "summary field", "contains")
edge("summary", "graph_out", "same summary object", "contains")
edge("graph_nodes", "graph_build", "nodes list", "contains", detailed=True)
edge("graph_edges", "graph_build", "edges list", "contains", detailed=True)
edge("graph", "graph_load", "loads via context", "call", detailed=True)
edge("graph_ctx", "graph_load", "stored centerlines", "context", detailed=True)
edge("graph_load", "normalize", "list[Centerline]", detailed=True)
edge("normalize", "deduplicate", "normalized centerlines", detailed=True)
edge("deduplicate", "duplicates", "returns", detailed=True)
edge("duplicates", "split", "representative centerlines", detailed=True)
edge("split", "build_records", "split centerline pieces", detailed=True)
edge("build_records", "graph_nodes", "nodes by coordinate + level", detailed=True)
edge("build_records", "graph_edges", "edges", detailed=True)
edge("build_records", "make_summary", "nodes + edges", detailed=True)
edge("make_summary", "summary", "returns GraphSummary", detailed=True)
edge("graph_build", "provenance", "assembled GraphBuild", detailed=True)
edge("duplicates", "provenance", "duplicate provenance", detailed=True)
edge("duplicates", "crossing_qa", "representative centerlines", detailed=True)
edge("provenance", "graph_qa", "graph with restored provenance", detailed=True)
edge("duplicates", "graph_qa", "merge groups", detailed=True)
edge("crossing_qa", "graph_qa", "crossing findings", detailed=True)
edge("graph_qa", "qa", "list[QAFinding]", detailed=True)
edge("graph_qa", "graph_write", "graph receives findings; summary.qa_count updated", detailed=True)
edge("graph_write", "graph_ctx", "sets .written_graph / .written_qa_findings", "context", detailed=True)
edge("graph_write", "graph_refs", "returns metadata only", "reference", detailed=True)
edge("graph_refs", "graph_out", "reference fields", "reference", detailed=True)

function("validate", "validate_graph", "validation", "Checks CRS and derives topology/geometry findings for the generated graph. It does not modify the graph. run_stages() ignores the returned findings because construction already includes them.", "pipeline/validation_graph.py", stage=True)
model("pipeline_result", "PipelineResult", "validation", "Runner-level bundle: generated GraphBuild, cleaned centerlines, combined generation QA, source folder/counts and settings. This is not a stage contract.", "pipeline_tools/run_pipeline.py", sub="runner bundle · actual data")
node("combined_qa", "list[QAFinding] · generation", "model", "validation", "Concatenation of skeletonization QA + cleanup QA + graph QA. Acquisition/transformation do not contribute QAFinding lists here.", path="pipeline/contracts/models.py", symbol="QAFinding", sub="three generation QA streams")
edge("graph_build", "validate", "graph argument; no graph changes")
edge("graph_out", "validate", "run identity", "reference")
edge("graph_build", "pipeline_result", "graph field; same generated graph")
edge("clean_lines", "pipeline_result", "centerlines field")
edge("skel_ctx", "combined_qa", ".qa_findings", "context")
edge("clean_ctx", "combined_qa", ".qa_findings", "context")
edge("graph_build", "combined_qa", ".qa_findings")
edge("combined_qa", "pipeline_result", "qa_findings field", "contains")
edge("qa", "combined_qa", "record type", "contains", detailed=True)

function("export", "write_outputs", "export", "Called by run_pipeline.main() after run_stages(). Converts actual graph/centerline/QA records to GeoDataFrames and writes the standard generated-DWN files.", "pipeline_tools/run_pipeline.py", stage=True)
node("frames", "GeoDataFrame layers", "model", "export", "Export-only tabular geometry representation. Different from the domain models and ArtifactRef metadata.", sub="edges · nodes · centerlines · QA", detailed=True)
function("gpkg_writer", "write_geopackage", "export", "Writes each named layer into a real GeoPackage file in the source CRS (EPSG:28992 here).", "pipeline_tools/export_dwn.py", detailed=True)
function("json_writer", "write_geojson_wgs84", "export", "Reprojects a layer to EPSG:4326 and writes a real GeoJSON file.", "pipeline_tools/export_dwn.py", detailed=True)
node("files", "Generated DWN exports", "file", "export", "Actual output/runs/<run_id>/dwn.gpkg (edges, nodes, centerlines, QA), plus edges.geojson, nodes.geojson and qa_findings.geojson.", sub="disk · .gpkg + .geojson")
function("run_info", "build_run_info", "export", "Collects source request, settings, counts, git commit and timings. main() serializes this dictionary to run.json.", "pipeline_tools/run_pipeline.py", detailed=True)
edge("pipeline_result", "export", "result argument")
edge("export", "files", "writes actual files")
edge("export", "frames", "converts records to layers", detailed=True)
edge("frames", "gpkg_writer", "all four layers", detailed=True)
edge("frames", "json_writer", "edges / nodes / QA layers", detailed=True)
edge("gpkg_writer", "files", "dwn.gpkg", detailed=True)
edge("json_writer", "files", "WGS84 GeoJSON files", detailed=True)
edge("pipeline_result", "run_info", "counts + settings + data_folder", detailed=True)

model("patches", "Patch", "corrections", "An ordered list of patches is supplied by the caller. Each patch has a bbox, before/after snapshots, ordered operations, a validity period and provenance.", "pipeline/contracts/models_corrections.py", sub="ordered list · saved JSON in demo",
      notes=["The Den Haag demo loads patches.json if present; otherwise author_patches() creates reviewed patches.", "There is no durable PostGIS patch store in this flow."])
function("replay", "apply_patches", "corrections", "Checks validity periods and replays active patches in saved order. Each patch is atomic; a failure produces QA and later patches are still attempted.", "pipeline/stages/corrections.py", stage=True,
         notes=["Called after run_stages() by demo_den_haag_hs.export_review(), and directly by synthetic demos.", "There are currently no CorrectionsInput / CorrectionsOutput stage envelopes or corrections storage context.", "Inputs are generated_dwn, patches, GenerationRun and timezone-aware replay time at.", "Rebuild from the generated graph after expiry/removal; there is no inverse edit.", "apply_patches() and apply_patch() share the private _replay_patch() implementation; apply_patches() does not call the public apply_patch() wrapper."])
model("patch_result", "PatchSetResult", "corrections", "In-memory replay return value: effective_dwn: GraphBuild, outcomes keyed by patch ID, and correction QA findings.", "pipeline/contracts/models_corrections.py", sub="actual graph + outcomes + correction QA")
model("effective", "GraphBuild · effective", "corrections", "The DWN after accepted patches. Generated input stays unchanged. GraphBuild.qa_findings retains the graph's original QA; new correction findings are separate on PatchSetResult.", symbol="GraphBuild", sub="actual modified DWN")
model("outcomes", "PatchOutcome", "corrections", "Per-patch result: applied, already_present, not_yet_active, expired or needs_review. This is separate from QA severity.", "pipeline/contracts/models_corrections.py", detailed=True)
node("correction_qa", "list[QAFinding] · corrections", "model", "corrections", "Findings from patch replay, including unresolved targets, snapshot changes and already-present notices. Returned separately from GraphBuild.qa_findings and the generation QA stream.", path="pipeline/contracts/models.py", symbol="QAFinding", detailed=True)
function("demo_export", "export_review", "corrections", "Den Haag-specific wrapper: calls apply_patches(), validates/checks the result, then exports both generated and effective graphs plus patch/QA review layers. It requires every saved patch to apply.", "pipeline_tools/demo_den_haag_hs.py", detailed=True)
node("demo_files", "Den Haag review exports", "file", "corrections", "output/manual-corrections/den-haag-hs/: comparison.gpkg, generated.geojson, effective.geojson, comparison.geojson, patches.json, comparison.png and run metadata.", sub="both graphs + patches + separate QA")
model("snapshot", "RegionState", "corrections", "A local graph snapshot containing nodes and edges. Used for expected_before and desired_after, and when selecting the current bbox region.", "pipeline/contracts/models_corrections.py", detailed=True)
model("path_target", "PathTarget", "corrections", "A structural selection defined by LineString geometry and relative level. It can cover whole edges, partial edges or a connected multi-edge path.", "pipeline/contracts/models_corrections.py", detailed=True)
model("node_target", "NodeTarget", "corrections", "A structural endpoint selection defined by coordinate and relative level; independent of regenerated node IDs.", "pipeline/contracts/models_corrections.py", detailed=True)
node("ops", "PatchOperation", "model", "corrections", "Discriminated union: SuppressPathOperation, SetAttributesOperation, AddEdgeOperation or ReshapeEdgeOperation. The operations list is executed in order as one atomic patch.", sub="four typed operation models", detailed=True)
for identifier, name, role in [
    ("attrs_model", "SetAttributesOperation", "Path selection plus a nonempty dictionary of routing/accessibility overrides."),
    ("suppress_model", "SuppressPathOperation", "Path selection describing the sections to remove."),
    ("add_model", "AddEdgeOperation", "New geometry and level, with optional start/end NodeTarget or PathTarget connections."),
    ("reshape_model", "ReshapeEdgeOperation", "One whole-edge structural target and its replacement geometry."),
]:
    model(identifier, name, "corrections", role, "pipeline/contracts/models_corrections.py", detailed=True)
model("resolved", "ResolvedPath", "corrections", "A read-only selection result containing EdgeSpan records in traversal order. Resolving alone does not split or modify graph edges.", "pipeline/contracts/models_corrections.py", detailed=True)
model("spans", "EdgeSpan", "corrections", "One selected edge section: the GraphEdge and start/end distances along its stored geometry.", "pipeline/contracts/models_corrections.py", detailed=True)
model("comparison", "ComparisonResult", "corrections", "Equivalent/different/ambiguous status, QA, paired meaningful nodes and matched groups of original edge IDs.", detailed=True)
function("single_patch", "apply_patch", "corrections", "Standalone single-patch wrapper around the shared private replay implementation. Returns (success, GraphBuild, findings); it does not schedule validity periods.", "pipeline/stages/corrections.py", detailed=True)
function("region", "resolve_region", "corrections", "Selects whole intersecting edges, their endpoints and nodes inside the patch bbox. Geometry is not clipped.", "pipeline/util/graph_comparison.py", detailed=True)
function("compare", "regions_equivalent", "corrections", "Compares complete snapshots by geometry, topology, levels and attributes while ignoring IDs and incidental degree-2 splits.", "pipeline/util/graph_comparison.py", detailed=True)
function("resolve", "resolve_path_target", "corrections", "Finds one unambiguous connected path matching a structural target and reports spans without mutating the graph.", "pipeline/util/patch_targets.py", detailed=True)
for identifier, name, role in [
    ("op_attrs", "patch_op_set_attributes", "Splits selected span boundaries and overrides attributes only on the selected sections."),
    ("op_suppress", "patch_op_suppress_path", "Splits selected boundaries and removes the selected sections, preserving outside paths and other branches."),
    ("op_add", "patch_op_add_edge", "Adds an edge, resolving node/path connections and splitting anchor edges only at attachment points."),
    ("op_reshape", "patch_op_reshape_edge", "Changes one whole edge's geometry while retaining its endpoint nodes and connections."),
]:
    function(identifier, name, "corrections", role, "pipeline/stages/corrections.py", detailed=True)
edge("pipeline_result", "replay", "Den Haag demo supplies result.graph", "demo")
edge("patches", "replay", "patches + run + at arguments")
edge("replay", "patch_result", "returns")
edge("patch_result", "effective", "effective_dwn field", "contains")
edge("patch_result", "outcomes", "outcomes dictionary", "contains", detailed=True)
edge("patch_result", "correction_qa", "qa_findings field", "contains", detailed=True)
edge("effective", "demo_files", "demo writes effective + generated DWN", "demo")
edge("patch_result", "demo_export", "replay result checked inside wrapper", detailed=True)
edge("demo_export", "demo_files", "writes comparison/review files", detailed=True)
edge("patches", "single_patch", "one patch + current graph + run", detailed=True)
edge("snapshot", "patches", "expected_before / desired_after", "contains", detailed=True)
edge("ops", "patches", "operations list", "contains", detailed=True)
edge("path_target", "ops", "path selection / connection", "contains", detailed=True)
edge("node_target", "ops", "optional ADD_EDGE connection", "contains", detailed=True)
edge("replay", "region", "via shared private replay: current graph + bbox", "call", detailed=True)
edge("single_patch", "region", "via same private replay implementation", "call", detailed=True)
edge("region", "snapshot", "returns current local snapshot", detailed=True)
edge("snapshot", "compare", "before/after/current snapshots", detailed=True)
edge("compare", "comparison", "returns comparison outcome", detailed=True)
edge("comparison", "patch_result", "gates replay / final acceptance; contributes QA", detailed=True)
edge("path_target", "resolve", "target geometry + current edges", detailed=True)
edge("resolve", "resolved", "returns selection or unresolved QA", detailed=True)
edge("spans", "resolved", "spans tuple", "contains", detailed=True)
for op in ("op_attrs", "op_suppress", "op_add", "op_reshape"):
    edge("ops", op, "dispatched by private replay implementation", "call", detailed=True)
    edge(op, "effective", "candidate GraphBuild; accepted only if whole patch verifies", detailed=True)
for operation_model, primitive in (("attrs_model", "op_attrs"), ("suppress_model", "op_suppress"), ("add_model", "op_add"), ("reshape_model", "op_reshape")):
    edge(operation_model, "ops", "member of discriminated union", "contains", detailed=True)
    edge(operation_model, primitive, "typed operation argument", detailed=True)
for op in ("op_attrs", "op_suppress", "op_add"):
    edge("resolved", op, "resolved selected spans", detailed=True)
edge("comparison", "correction_qa", "ambiguous/mismatched snapshots", detailed=True)

for stage in ("acq", "trans", "skel", "clean", "graph", "validate"):
    edge("runner", stage, "orchestrates", "call", detailed=stage != "acq")
edge("runner", "pipeline_result", "returns assembled result", "call")

COLORS = {
    "stage": ("#24212e", "#8b7ec8", "#d5c9f2"),
    "function": ("#24212e", "#8b7ec8", "#d5c9f2"),
    "model": ("#172a27", "#3aa99f", "#b2ded5"),
    "reference": ("#2c2718", "#d0a215", "#e6ce7d"),
    "context": ("#1a242d", "#4385be", "#a9cce9"),
    "file": ("#302119", "#da702c", "#e9b79b"),
}
EDGE_COLORS = {"data": "#cecdc3", "reference": "#d4bd74", "context": "#8ab0ce", "contains": "#8bc3ad", "call": "#b5a6d3", "demo": "#dfad83"}


def build_dot(view):
    """Draw dataflow edges and stage clusters; calls do not determine layout."""
    detailed = view == "functions"
    visible = {key: value for key, value in NODES.items() if detailed or not value["detailed"]}
    lines = ["digraph Pipeline {", 'graph [rankdir=LR, bgcolor="#111111", pad="0.3", nodesep="0.5", ranksep="0.6", compound=true, newrank=true, fontname="DejaVu Sans", fontsize=20, splines=spline, outputorder=edgesfirst];',
             'node [shape=box, style="rounded,filled", fontname="DejaVu Sans", fontsize=17, margin="0.22,0.18", penwidth=1.6];',
             'edge [fontname="DejaVu Sans", fontsize=13, arrowsize=1.05, penwidth=2.2];']
    for group, (title, _) in GROUPS.items():
        items = [item for item in visible.values() if item["group"] == group]
        if not items:
            continue
        title = title.replace("·", "•")
        lines.append(f'subgraph cluster_{group} {{ graph [id="group_{group}", label={json.dumps(title, ensure_ascii=False)}, style="rounded,filled", color="#343331", fillcolor="#181716", fontcolor="#cecdc3", labeljust=l, margin=25];')
        for item in items:
            fill, stroke, text = COLORS[item["kind"]]
            label = html.escape(item["label"]).replace("·", "&#8226;")
            subtitle = html.escape(item["sub"]).replace("·", "&#8226;")
            secondary = f'<BR/><FONT POINT-SIZE="14">{subtitle}</FONT>' if subtitle else ""
            lines.append(f'{json.dumps(item["id"])} [id="node_{item["id"]}", label=<<B>{label}</B>{secondary}>, fillcolor="{fill}", color="{stroke}", fontcolor="{text}"];')
        lines.append("}")
    visible_edges = []
    for item in EDGES:
        if item["from"] not in visible or item["to"] not in visible or (item["detailed"] and not detailed):
            continue
        # The detailed view expands a few overview shortcuts into their actual functions.
        if detailed and (item["from"], item["to"]) in {
            ("bgt_cache", "acq"), ("surfaces", "surface_ref"), ("skel", "skel_ctx"),
            ("clean", "clean_ctx"), ("graph", "graph_ctx"), ("clean_lines", "graph_input"),
            ("effective", "demo_files"), ("export", "files"),
        }:
            continue
        visible_edges.append(item)
        style = "dashed" if item["kind"] in ("reference", "context", "demo") else "dotted" if item["kind"] in ("contains", "call") else "solid"
        constraint = "false" if item["kind"] == "call" or (item["from"], item["to"]) in {("comparison", "patch_result"), ("op_attrs", "effective"), ("op_suppress", "effective"), ("op_add", "effective"), ("op_reshape", "effective")} else "true"
        label = textwrap.fill(item["label"], width=24, break_long_words=False, break_on_hyphens=False)
        lines.append(f'{json.dumps(item["from"])} -> {json.dumps(item["to"])} [id="{item["id"]}", label={json.dumps(label)}, color="{EDGE_COLORS[item["kind"]]}", fontcolor="#cecdc3", style="{style}", constraint={constraint}];')
    lines.append("}")
    source = "\n".join(lines)
    (DESTINATION / f"{view}.dot").write_text(source)
    svg = subprocess.run(["dot", "-Tsvg"], input=source, text=True, capture_output=True, check=True).stdout
    svg = svg[svg.index("<svg"):]
    (DESTINATION / f"{view}.svg").write_text(svg)
    return {"svg": svg, "nodes": list(visible), "edges": visible_edges}


def main():
    """Write offline HTML plus editable Graphviz sources and static SVG exports."""
    views = {name: build_dot(name) for name in ("stages", "functions")}
    commit = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    data = {"views": views, "nodes": NODES, "groups": GROUPS, "commit": commit}
    template = (DESTINATION / "template.html").read_text()
    template = template.replace("/* DIAGRAM_STYLES */", (DESTINATION / "style.css").read_text())
    payload = json.dumps(data).replace("<", "\\u003c")
    (DESTINATION / "index.html").write_text(template.replace("/* DIAGRAM_DATA */", payload))
    print(f"Built {len(NODES)} nodes and {len(EDGES)} connections at {DESTINATION / 'index.html'}")


if __name__ == "__main__":
    main()
