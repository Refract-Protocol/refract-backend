import { Test, TestingModule } from '@nestjs/testing';
import { ReferenceDataService } from './reference-data.service';
import { ReferenceDataRepository } from './reference-data.repository';
import {
  ReferenceEntity,
  ReferenceDataset,
  EntityResolution,
} from './reference-data.types';

describe('ReferenceDataService', () => {
  let service: ReferenceDataService;
  let repository: jest.Mocked<ReferenceDataRepository>;

  const datasetV1: ReferenceDataset = {
    id: 'ds-flightdelay-v1',
    name: 'flightdelay',
    version: 1,
    effectiveFrom: new Date('2024-01-01T00:00:00Z'),
    effectiveTo: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
  };

  const datasetV2: ReferenceDataset = {
    id: 'ds-flightdelay-v2',
    name: 'flightdelay',
    version: 2,
    effectiveFrom: new Date('2024-06-01T00:00:00Z'),
    effectiveTo: null,
    createdAt: new Date('2024-06-01T00:00:00Z'),
  };

  const airportJfk: ReferenceEntity = {
    id: 'ent-airport-jfk',
    datasetId: datasetV1.id,
    entityType: 'airport',
    canonicalId: 'JFK',
    attributes: { name: 'John F. Kennedy International Airport', country: 'US' },
    effectiveFrom: new Date('2024-01-01T00:00:00Z'),
    effectiveTo: null,
    retired: false,
  };

  const airportLhr: ReferenceEntity = {
    id: 'ent-airport-lhr',
    datasetId: datasetV1.id,
    entityType: 'airport',
    canonicalId: 'LHR',
    attributes: { name: 'London Heathrow Airport', country: 'GB' },
    effectiveFrom: new Date('2024-01-01T00:00:00Z'),
    effectiveTo: null,
    retired: false,
  };

  const airportOldRetired: ReferenceEntity = {
    id: 'ent-airport-old',
    datasetId: datasetV1.id,
    entityType: 'airport',
    canonicalId: 'OLD',
    attributes: { name: 'Old Airport', country: 'US' },
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    effectiveTo: new Date('2023-01-01T00:00:00Z'),
    retired: true,
  };

  const carrierAlias1: EntityResolution = {
    id: 'res-1',
    datasetId: datasetV1.id,
    entityType: 'carrier',
    providerId: 'provider-a',
    providerNativeId: 'AA-123',
    canonicalId: 'AA',
    effectiveFrom: new Date('2024-01-01T00:00:00Z'),
    effectiveTo: null,
  };

  const carrierAlias2: EntityResolution = {
    id: 'res-2',
    datasetId: datasetV1.id,
    entityType: 'carrier',
    providerId: 'provider-b',
    providerNativeId: 'AAL',
    canonicalId: 'AA',
    effectiveFrom: new Date('2024-01-01T00:00:00Z'),
    effectiveTo: null,
  };

  const ambiguousResolution1: EntityResolution = {
    id: 'res-amb-1',
    datasetId: datasetV1.id,
    entityType: 'asset',
    providerId: 'provider-c',
    providerNativeId: 'USDC',
    canonicalId: 'USDC-ETH',
    effectiveFrom: new Date('2024-01-01T00:00:00Z'),
    effectiveTo: null,
  };

  const ambiguousResolution2: EntityResolution = {
    id: 'res-amb-2',
    datasetId: datasetV1.id,
    entityType: 'asset',
    providerId: 'provider-c',
    providerNativeId: 'USDC',
    canonicalId: 'USDC-POLYGON',
    effectiveFrom: new Date('2024-01-01T00:00:00Z'),
    effectiveTo: null,
  };

  beforeEach(async () => {
    const mockRepository: jest.Mocked<ReferenceDataRepository> = {
      getDataset: jest.fn(),
      getDatasetByNameAndVersion: jest.fn(),
      getEntity: jest.fn(),
      findEntitiesByCanonicalId: jest.fn(),
      resolveProviderId: jest.fn(),
      listResolutions: jest.fn(),
    } as unknown as jest.Mocked<ReferenceDataRepository>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferenceDataService,
        { provide: ReferenceDataRepository, useValue: mockRepository },
      ],
    }).compile();

    service = module.get<ReferenceDataService>(ReferenceDataService);
    repository = module.get(ReferenceDataRepository);
  });

  describe('validateEntity', () => {
    it('accepts a known, active entity', async () => {
      repository.getEntity.mockResolvedValue(airportJfk);

      const result = await service.validateEntity(
        datasetV1.id,
        'airport',
        'JFK',
      );

      expect(result.valid).toBe(true);
      expect(result.canonicalId).toBe('JFK');
      expect(result.reason).toBeUndefined();
    });

    it('rejects an unknown entity', async () => {
      repository.getEntity.mockResolvedValue(null);

      const result = await service.validateEntity(
        datasetV1.id,
        'airport',
        'ZZZ',
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/unknown/i);
      expect(result.canonicalId).toBeUndefined();
    });

    it('rejects a retired entity', async () => {
      repository.getEntity.mockResolvedValue(airportOldRetired);

      const result = await service.validateEntity(
        datasetV1.id,
        'airport',
        'OLD',
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/retired/i);
    });

    it('rejects an entity whose effective window has ended', async () => {
      const expiredEntity: ReferenceEntity = {
        ...airportLhr,
        effectiveTo: new Date('2024-02-01T00:00:00Z'),
      };
      repository.getEntity.mockResolvedValue(expiredEntity);

      const result = await service.validateEntity(
        datasetV1.id,
        'airport',
        'LHR',
        new Date('2024-03-01T00:00:00Z'),
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/retired|expired|effective/i);
    });

    it('accepts a retired entity when evaluated at a historical timestamp within its window', async () => {
      repository.getEntity.mockResolvedValue(airportOldRetired);

      const result = await service.validateEntity(
        datasetV1.id,
        'airport',
        'OLD',
        new Date('2022-06-01T00:00:00Z'),
      );

      expect(result.valid).toBe(true);
      expect(result.canonicalId).toBe('OLD');
    });
  });

  describe('resolveProviderId', () => {
    it('resolves a provider-native ID to a canonical ID', async () => {
      repository.resolveProviderId.mockResolvedValue([carrierAlias1]);

      const result = await service.resolveProviderId(
        datasetV1.id,
        'carrier',
        'provider-a',
        'AA-123',
      );

      expect(result.resolved).toBe(true);
      expect(result.canonicalId).toBe('AA');
      expect(result.ambiguous).toBe(false);
    });

    it('resolves many-to-one aliases to the same canonical ID', async () => {
      repository.resolveProviderId
        .mockResolvedValueOnce([carrierAlias1])
        .mockResolvedValueOnce([carrierAlias2]);

      const first = await service.resolveProviderId(
        datasetV1.id,
        'carrier',
        'provider-a',
        'AA-123',
      );
      const second = await service.resolveProviderId(
        datasetV1.id,
        'carrier',
        'provider-b',
        'AAL',
      );

      expect(first.resolved).toBe(true);
      expect(second.resolved).toBe(true);
      expect(first.canonicalId).toBe('AA');
      expect(second.canonicalId).toBe('AA');
    });

    it('rejects an ambiguous match when multiple canonical IDs share a provider-native ID', async () => {
      repository.resolveProviderId.mockResolvedValue([
        ambiguousResolution1,
        ambiguousResolution2,
      ]);

      const result = await service.resolveProviderId(
        datasetV1.id,
        'asset',
        'provider-c',
        'USDC',
      );

      expect(result.resolved).toBe(false);
      expect(result.ambiguous).toBe(true);
      expect(result.canonicalId).toBeUndefined();
      expect(result.reason).toMatch(/ambiguous/i);
    });

    it('rejects an unknown provider-native ID', async () => {
      repository.resolveProviderId.mockResolvedValue([]);

      const result = await service.resolveProviderId(
        datasetV1.id,
        'carrier',
        'provider-a',
        'UNKNOWN',
      );

      expect(result.resolved).toBe(false);
      expect(result.ambiguous).toBe(false);
      expect(result.reason).toMatch(/unknown|unresolved/i);
    });
  });

  describe('version pinning', () => {
    it('loads the exact dataset version pinned in config', async () => {
      repository.getDatasetByNameAndVersion.mockResolvedValue(datasetV1);

      const dataset = await service.getPinnedDataset('flightdelay', 1);

      expect(repository.getDatasetByNameAndVersion).toHaveBeenCalledWith(
        'flightdelay',
        1,
      );
      expect(dataset).toEqual(datasetV1);
    });

    it('does not fall back to a newer version when the pinned version is missing', async () => {
      repository.getDatasetByNameAndVersion.mockResolvedValue(null);

      await expect(service.getPinnedDataset('flightdelay', 99)).rejects.toThrow(
        /dataset.*not found|version.*not found/i,
      );
      expect(repository.getDatasetByNameAndVersion).toHaveBeenCalledWith(
        'flightdelay',
        99,
      );
    });

    it('validates against the pinned dataset version, not the latest', async () => {
      repository.getDatasetByNameAndVersion.mockResolvedValue(datasetV1);
      repository.getEntity.mockResolvedValue(airportJfk);

      const dataset = await service.getPinnedDataset('flightdelay', 1);
      const result = await service.validateEntity(dataset.id, 'airport', 'JFK');

      expect(repository.getEntity).toHaveBeenCalledWith(
        datasetV1.id,
        'airport',
        'JFK',
      );
      expect(result.valid).toBe(true);
    });

    it('keeps historical interpretation stable when a newer dataset version exists', async () => {
      repository.getDatasetByNameAndVersion.mockImplementation(
        async (_name: string, version: number) =>
          version === 1 ? datasetV1 : datasetV2,
      );
      repository.getEntity.mockImplementation(
        async (datasetId: string, _type: string, canonicalId: string) => {
          if (datasetId === datasetV1.id && canonicalId === 'JFK') {
            return airportJfk;
          }
          if (datasetId === datasetV2.id && canonicalId === 'JFK') {
            return { ...airportJfk, datasetId: datasetV2.id };
          }
          return null;
        },
      );

      const pinnedV1 = await service.getPinnedDataset('flightdelay', 1);
      const pinnedV2 = await service.getPinnedDataset('flightdelay', 2);

      const resultV1 = await service.validateEntity(
        pinnedV1.id,
        'airport',
        'JFK',
      );
      const resultV2 = await service.validateEntity(
        pinnedV2.id,
        'airport',
        'JFK',
      );

      expect(resultV1.valid).toBe(true);
      expect(resultV2.valid).toBe(true);
      expect(repository.getEntity).toHaveBeenNthCalledWith(
        1,
        datasetV1.id,
        'airport',
        'JFK',
      );
      expect(repository.getEntity).toHaveBeenNthCalledWith(
        2,
        datasetV2.id,
        'airport',
        'JFK',
      );
    });
  });
});