var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { FilesModule } from './files/files.module.js';
import { HealthController } from './health/health.controller.js';
import { NodesModule } from './nodes/nodes.module.js';
import { PermissionsModule } from './permissions/permissions.module.js';
import { TrashModule } from './trash/trash.module.js';
import { SharingModule } from './sharing/sharing.module.js';
import { SearchModule } from './search/search.module.js';
import { EditorModule } from './editor/editor.module.js';
let AppModule = class AppModule {
};
AppModule = __decorate([
    Module({
        imports: [
            DatabaseModule,
            AuthModule,
            AdminModule,
            AuthorizationModule,
            NodesModule,
            PermissionsModule,
            FilesModule,
            TrashModule,
            SharingModule,
            SearchModule,
            EditorModule,
        ],
        controllers: [HealthController],
    })
], AppModule);
export { AppModule };
//# sourceMappingURL=app.module.js.map