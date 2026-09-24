/**
 * Small orchestration layer for the browser flow:
 * vehicle -> major section -> subcategory/page -> priced parts.
 *
 * Request bodies are passed through because the JLR catalogue varies fields
 * such as retailer, user role, market, VIN and feature codes by account.
 */
export class JlrWorkflow {
  constructor(catalogue) {
    this.catalogue = catalogue;
  }

  async vehicle(body) {
    return this.catalogue.decodeVehicle(body);
  }

  async sections(body) {
    return this.catalogue.majorSections(body);
  }

  async children(body) {
    return this.catalogue.nextLevel(body);
  }

  async parts({ catalogueId, vin, featureCodes = [] }) {
    return this.catalogue.parts({ catalogueId, vin, featureCodes });
  }
}