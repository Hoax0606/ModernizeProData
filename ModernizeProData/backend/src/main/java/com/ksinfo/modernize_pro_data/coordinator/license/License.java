package com.ksinfo.modernize_pro_data.coordinator.license;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "license")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class License {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "license_id", nullable = false, length = 128)
    private String licenseId;

    @Column(nullable = false, length = 256)
    private String customer;

    @Column(name = "site_id", nullable = false, length = 128)
    private String siteId;

    @Column(nullable = false, length = 32)
    private String edition;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb", nullable = false)
    private List<String> features;

    @Column(name = "issued_at", nullable = false)
    private LocalDate issuedAt;

    @Column(name = "expires_at", nullable = false)
    private LocalDate expiresAt;

    @Column(name = "grace_days", nullable = false)
    private int graceDays;

    @Column(name = "public_key_fp", nullable = false, length = 64)
    private String publicKeyFp;

    @Column(name = "raw_jws", columnDefinition = "TEXT", nullable = false)
    private String rawJws;

    @Column(name = "last_seen_at")
    private OffsetDateTime lastSeenAt;

    @Column(name = "imported_at", nullable = false)
    private OffsetDateTime importedAt;

    @Column(name = "imported_by", nullable = false, length = 64)
    private String importedBy;

    static License create(LicenseDocument.Payload p, String rawJws, String importedBy) {
        License lic = new License();
        lic.id = "l-" + UUID.randomUUID().toString().substring(0, 8);
        lic.licenseId = p.licenseId();
        lic.customer = p.customer();
        lic.siteId = p.siteId();
        lic.edition = p.edition();
        lic.features = p.features();
        lic.issuedAt = p.issuedAt();
        lic.expiresAt = p.expiresAt();
        lic.graceDays = p.graceDays();
        lic.publicKeyFp = p.publicKeyFp();
        lic.rawJws = rawJws;
        lic.importedAt = OffsetDateTime.now();
        lic.importedBy = importedBy;
        return lic;
    }
}
