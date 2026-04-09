/**
 * LandXML Export — convert accumulated survey elements to LandXML format.
 *
 * LandXML is the standard exchange format for survey/civil engineering data.
 * This module generates a valid LandXML 1.2 document from the reconstruction output.
 */

import type { SurveyElement } from "./reconstruction-agent";
import type { CoordSystem } from "./coord-system";
import { formatBearing } from "./cogo";

/**
 * Generate a LandXML document from the reconstructed survey elements.
 */
export function exportLandXML(
  elements: SurveyElement[],
  coordSystem: CoordSystem,
  metadata: {
    tractNumber?: string;
    lotNumber?: string;
    county?: string;
    state?: string;
    surveyDate?: string;
    projectName?: string;
  },
): string {
  const lines: string[] = [];

  // Header
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">`);

  // Project info
  lines.push(`  <Project name="${esc(metadata.projectName ?? `Tract ${metadata.tractNumber ?? ""}`)}">`);
  if (metadata.county || metadata.state) {
    lines.push(`    <Feature name="location">`);
    if (metadata.county) lines.push(`      <Property label="county" value="${esc(metadata.county)}" />`);
    if (metadata.state) lines.push(`      <Property label="state" value="${esc(metadata.state)}" />`);
    lines.push(`    </Feature>`);
  }
  lines.push(`  </Project>`);

  // Coordinate system
  lines.push(`  <CoordinateSystem>`);
  lines.push(`    <Feature name="localDatum">`);
  lines.push(`      <Property label="scale" value="${esc(coordSystem.scaleText)}" />`);
  lines.push(`      <Property label="dpi" value="${coordSystem.dpi}" />`);
  lines.push(`      <Property label="pxPerFoot" value="${coordSystem.pxPerFoot.toFixed(4)}" />`);
  lines.push(`    </Feature>`);
  lines.push(`  </CoordinateSystem>`);

  // CgPoints — all unique points
  const pointMap = new Map<string, { id: string; x: number; y: number }>();
  let pointIdx = 1;
  for (const el of elements) {
    for (const pt of el.surveyPoints) {
      const key = `${pt.x.toFixed(4)},${pt.y.toFixed(4)}`;
      if (!pointMap.has(key)) {
        pointMap.set(key, { id: `P${pointIdx++}`, x: pt.x, y: pt.y });
      }
    }
  }

  lines.push(`  <CgPoints>`);
  for (const [, pt] of pointMap) {
    lines.push(`    <CgPoint name="${pt.id}" pntSurv="boundary">${pt.y.toFixed(4)} ${pt.x.toFixed(4)}</CgPoint>`);
  }
  lines.push(`  </CgPoints>`);

  // Monuments
  const monuments = elements.filter((e) => e.elementType === "monument");
  if (monuments.length > 0) {
    lines.push(`  <Monuments>`);
    for (const mon of monuments) {
      const pt = mon.surveyPoints[0];
      const key = `${pt.x.toFixed(4)},${pt.y.toFixed(4)}`;
      const pntId = pointMap.get(key)?.id ?? "unknown";
      const desc = mon.monument?.description ?? mon.description;
      const shape = mon.monument?.shape ?? "unknown";
      lines.push(`    <Monument name="${esc(mon.id)}" pntRef="${pntId}" type="${esc(shape)}" desc="${esc(desc)}">`);
      if (mon.monument?.rceNumber) {
        lines.push(`      <Feature name="rce"><Property label="number" value="${esc(mon.monument.rceNumber)}" /></Feature>`);
      }
      if (mon.monument?.lsNumber) {
        lines.push(`      <Feature name="ls"><Property label="number" value="${esc(mon.monument.lsNumber)}" /></Feature>`);
      }
      lines.push(`    </Monument>`);
    }
    lines.push(`  </Monuments>`);
  }

  // Parcels
  const lotBoundaries = elements.filter(
    (e) => e.elementType === "lot_boundary" || e.elementType === "easement",
  );
  if (lotBoundaries.length > 0) {
    lines.push(`  <Parcels>`);
    const lotName = metadata.lotNumber ? `LOT ${metadata.lotNumber}` : "LOT";
    lines.push(`    <Parcel name="${esc(lotName)}" class="Lot">`);
    lines.push(`      <CoordGeom>`);

    for (const el of lotBoundaries) {
      if (el.geometryType === "line" && el.surveyPoints.length >= 2) {
        const start = el.surveyPoints[0];
        const end = el.surveyPoints[el.surveyPoints.length - 1];
        const dir = el.bearing ? esc(el.bearing) : formatBearing(0);
        const dist = el.distance?.toFixed(4) ?? "0";
        lines.push(`        <Line dir="${dir}" length="${dist}" desc="${esc(el.description)}">`);
        lines.push(`          <Start>${start.y.toFixed(4)} ${start.x.toFixed(4)}</Start>`);
        lines.push(`          <End>${end.y.toFixed(4)} ${end.x.toFixed(4)}</End>`);
        lines.push(`        </Line>`);
      } else if (el.geometryType === "arc" && el.surveyPoints.length >= 2) {
        const start = el.surveyPoints[0];
        const end = el.surveyPoints[el.surveyPoints.length - 1];
        lines.push(`        <Curve rot="${el.curveDirection === "LEFT" ? "ccw" : "cw"}" `
          + `radius="${el.radius?.toFixed(4) ?? "0"}" `
          + `delta="${esc(el.delta ?? "0")}" `
          + `length="${el.arcLength?.toFixed(4) ?? "0"}" `
          + `desc="${esc(el.description)}">`);
        lines.push(`          <Start>${start.y.toFixed(4)} ${start.x.toFixed(4)}</Start>`);
        lines.push(`          <End>${end.y.toFixed(4)} ${end.x.toFixed(4)}</End>`);
        lines.push(`        </Curve>`);
      }
    }

    lines.push(`      </CoordGeom>`);
    lines.push(`    </Parcel>`);

    // Easements as separate parcels
    const easements = elements.filter((e) => e.elementType === "easement");
    if (easements.length > 0) {
      lines.push(`    <Parcel name="EASEMENT" class="Easement">`);
      lines.push(`      <CoordGeom>`);
      for (const el of easements) {
        if (el.geometryType === "line" && el.surveyPoints.length >= 2) {
          const start = el.surveyPoints[0];
          const end = el.surveyPoints[el.surveyPoints.length - 1];
          lines.push(`        <Line dir="${esc(el.bearing ?? "")}" length="${el.distance?.toFixed(4) ?? "0"}" desc="${esc(el.description)}">`);
          lines.push(`          <Start>${start.y.toFixed(4)} ${start.x.toFixed(4)}</Start>`);
          lines.push(`          <End>${end.y.toFixed(4)} ${end.x.toFixed(4)}</End>`);
          lines.push(`        </Line>`);
        }
      }
      lines.push(`      </CoordGeom>`);
      lines.push(`    </Parcel>`);
    }

    lines.push(`  </Parcels>`);
  }

  lines.push(`</LandXML>`);
  return lines.join("\n");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
